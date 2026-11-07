import { Router, json, type NextFunction, type Request, type Response } from 'express';
import { waitUntil } from '@vercel/functions';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from './config';
import { db } from './db';
import { ledgerFor, record, verifyChain } from './ledger';
import { chargeVisitor, LimitReached } from './limits';
import { seedIfEmpty } from './seed';
import { DraftSchema, draftPact } from './ai/draft';
import { modelName, provider } from './ai/llm';
import { translateLedgerQuery } from './ai/ledgerQuery';
import { paypal } from './paypal/client';
import { now } from './clock';
import * as E from './engine/pacts';
import type { Pact, Role } from './types';

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Each party holds a private link. The key in it decides what that person can do. */
function roleOf(pact: Pact, key: unknown): Role | null {
  if (typeof key !== 'string') return null;
  if (safeEqual(key, pact.buyer_key)) return 'buyer';
  if (safeEqual(key, pact.worker_key)) return 'worker';
  return null;
}

const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, '$1***$2');

async function pactView(pact: Pact, role: Role | null) {
  const { buyer_key, worker_key, ...rest } = pact;
  const milestones = await Promise.all((await E.milestonesOf(pact.id)).map(async (m) => ({
    ...m, verifications: await E.verificationsOf(m.id), tribunal: await E.tribunalOf(m.id),
  })));
  return {
    ...rest,
    buyer_email: role ? rest.buyer_email : maskEmail(rest.buyer_email),
    worker_email: role ? rest.worker_email : maskEmail(rest.worker_email),
    role, milestones, ledger: await ledgerFor(pact.id), chain: await verifyChain(pact.id),
    links: role === 'buyer' ? { worker: `/p/${pact.id}?k=${worker_key}` } : undefined,
  };
}

const CreateSchema = z.object({
  draft: DraftSchema,
  buyer_email: z.email(),
  worker_email: z.email(),
  source_text: z.string().max(20_000).default(''),
  challenge_seconds: z.number().int().min(10).max(14 * 86_400).optional(),
  auto_release_max: z.number().min(0).optional(),
  ai_arbitration: z.boolean().optional(),
});

const SubmitSchema = z.object({
  text: z.string().min(1).max(30_000),
  url: z.url().nullable().optional(),
});
const StatementSchema = z.object({ statement: z.string().min(1).max(4000) });

const visitor = (req: Request) => req.ip ?? 'unknown';

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const route = (h: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve().then(() => h(req, res)).catch(next);

export function apiRouter() {
  const r = Router();
  r.use(json({ limit: '1mb' }));

  const authed = async (req: Request, only?: Role) => {
    const pact = await E.getPact(String(req.params.id));
    if (!pact) throw new NotFound('Pact not found');
    const role = roleOf(pact, req.get('x-pact-key'));
    if (!role) throw new Forbidden('This action needs your private pact link');
    if (only && role !== only) throw new Forbidden(`Only the ${only} can do this`);
    return { pact, role };
  };

  const milestoneIn = async (pact: Pact, id: unknown) => {
    const m = await E.getMilestone(String(id));
    if (m.pact_id !== pact.id) throw new Forbidden('That milestone belongs to another pact');
    return m;
  };

  r.get('/meta', (_q, s) => {
    s.json({
      paypal_mode: config.paypal.mode,
      paypal_client_id: config.paypal.mode === 'sandbox' ? config.paypal.clientId : null,
      ai_provider: provider(), ai_model: modelName(), fee_bps: config.feeBps,
    });
  });

  r.post('/drafts', route(async (req, res) => {
    const { text } = z.object({ text: z.string().min(10).max(20_000) }).parse(req.body);
    await chargeVisitor(visitor(req), 1);
    res.json(await draftPact(text));
  }));

  r.post('/pacts', route(async (req, res) => {
    const input = CreateSchema.parse(req.body);
    const pact = await E.createPact(input);
    res.status(201).json({
      id: pact.id,
      buyer_link: `/p/${pact.id}?k=${pact.buyer_key}`,
      worker_link: `/p/${pact.id}?k=${pact.worker_key}`,
    });
  }));

  r.get('/pacts', route(async (_q, res) => {
    if (!config.publicLedger) throw new Forbidden('The public index is disabled');
    await seedIfEmpty();
    res.json((await E.listPacts()).map((p) => ({
      id: p.id, title: p.title, status: p.status, total_cents: p.total_cents,
      captured_cents: p.captured_cents, currency: p.currency, created_at: p.created_at,
    })));
  }));

  r.get('/pacts/:id', route(async (req, res) => {
    const pact = await E.getPact(String(req.params.id));
    if (!pact) throw new NotFound('Pact not found');
    // Open pages drive time-based work, since serverless has no background process.
    waitUntil(E.sweep(pact.id).catch((err) => console.error('sweep', pact.id, err)));
    res.json(await pactView(pact, roleOf(pact, req.get('x-pact-key'))));
  }));

  r.post('/pacts/:id/sign', route(async (req, res) => {
    const { pact } = await authed(req, 'worker');
    await E.signPact(pact);
    res.json({ ok: true });
  }));

  r.post('/pacts/:id/order', route(async (req, res) => {
    const { pact } = await authed(req, 'buyer');
    res.json(await E.createFundingOrder(pact));
  }));

  r.post('/pacts/:id/authorize', route(async (req, res) => {
    const { pact } = await authed(req, 'buyer');
    const { orderId } = z.object({ orderId: z.string() }).parse(req.body);
    await E.completeFunding(pact, orderId);
    res.json({ ok: true });
  }));

  // Where PayPal sends the buyer back after approving on a hosted page (used by agent flows).
  r.get('/paypal/return', route(async (req, res) => {
    const pact = await E.getPact(String(req.query.pact));
    const orderId = String(req.query.token ?? '');
    if (!pact || pact.order_id !== orderId) throw new NotFound('Unknown order');
    await E.completeFunding(pact, orderId);
    res.redirect(`/p/${pact.id}`);
  }));

  r.post('/pacts/:id/milestones/:mid/submit', route(async (req, res) => {
    const { pact } = await authed(req, 'worker');
    const m = await milestoneIn(pact, req.params.mid);
    const { text, url } = SubmitSchema.parse(req.body);
    await chargeVisitor(visitor(req), 2);
    res.json(await E.submitWork(m.id, text, url ?? null));
  }));

  r.post('/pacts/:id/milestones/:mid/approve', route(async (req, res) => {
    const { pact } = await authed(req, 'buyer');
    await E.approve((await milestoneIn(pact, req.params.mid)).id);
    res.json({ ok: true });
  }));

  r.post('/pacts/:id/milestones/:mid/contest', route(async (req, res) => {
    const { pact, role } = await authed(req);
    const { statement } = StatementSchema.parse(req.body);
    await E.contest((await milestoneIn(pact, req.params.mid)).id, role, statement);
    res.json({ ok: true });
  }));

  r.post('/pacts/:id/milestones/:mid/respond', route(async (req, res) => {
    const { pact, role } = await authed(req);
    const { statement } = StatementSchema.parse(req.body);
    const m = await milestoneIn(pact, req.params.mid);
    await chargeVisitor(visitor(req), 5);
    await E.fileResponse(m.id, role, statement);
    // The hearing outlives this reply, and the page follows it by polling. waitUntil keeps a
    // serverless function alive until it ends, and is a no-op when self-hosted.
    waitUntil(E.convene(m.id).catch((err) => console.error('tribunal', m.id, err)));
    res.status(202).json({ ok: true });
  }));

  r.post('/pacts/:id/milestones/:mid/reconvene', route(async (req, res) => {
    const { pact } = await authed(req);
    const m = await milestoneIn(pact, req.params.mid);
    await chargeVisitor(visitor(req), 5);
    await E.reopenHearing(m.id);
    waitUntil(E.convene(m.id).catch((err) => console.error('tribunal', m.id, err)));
    res.status(202).json({ ok: true });
  }));

  r.post('/pacts/:id/milestones/:mid/forfeit', route(async (req, res) => {
    const { pact, role } = await authed(req);
    await E.forfeit((await milestoneIn(pact, req.params.mid)).id, role);
    res.json({ ok: true });
  }));

  r.post('/pacts/:id/milestones/:mid/retry-payout', route(async (req, res) => {
    const { pact } = await authed(req);
    await E.retryPayout((await milestoneIn(pact, req.params.mid)).id);
    res.json({ ok: true });
  }));

  // Vercel Cron sends CRON_SECRET as a bearer token.
  r.get('/cron/sweep', route(async (req, res) => {
    if (!config.cronSecret || req.get('authorization') !== `Bearer ${config.cronSecret}`) throw new Forbidden('Not allowed');
    await E.sweep();
    res.json({ ok: true });
  }));

  r.get('/ledger', route(async (_q, res) => {
    if (!config.publicLedger) throw new Forbidden('The public ledger is disabled');
    await seedIfEmpty();
    const rows = await db.all<Record<string, unknown>>(`SELECT l.seq, l.pact_id, p.title AS pact_title, p.currency, l.milestone_id, l.type, l.actor,
      l.amount_cents, l.paypal_ref, l.detail, l.at, l.hash
      FROM ledger l JOIN pacts p ON p.id = l.pact_id ORDER BY l.seq DESC LIMIT 2000`);
    const pacts = [...new Set(rows.map((x) => x.pact_id as string))];
    const checks = await Promise.all(pacts.map(async (id) => [id, (await verifyChain(id)).intact] as const));
    res.json({
      rows: rows.map((x) => ({ ...x, detail: String(x.detail).replace(/\S+@\S+/g, maskEmail) })),
      chains: Object.fromEntries(checks),
    });
  }));

  r.post('/ledger/ask', route(async (req, res) => {
    const { q } = z.object({ q: z.string().min(2).max(300) }).parse(req.body);
    await chargeVisitor(visitor(req), 1);
    const types = (await db.all<{ type: string }>('SELECT DISTINCT type FROM ledger')).map((t) => t.type);
    res.json(await translateLedgerQuery(q, types));
  }));

  r.post('/paypal/webhook', route(async (req, res) => {
    if (!config.paypal.webhookId) throw new Forbidden('Webhook verification is not configured');
    const { verification_status } = await paypal.verifyWebhook({ headers: req.headers, event: req.body });
    if (verification_status !== 'SUCCESS') throw new Forbidden('Bad webhook signature');
    const { event_type, resource } = req.body as { event_type: string; resource?: { id?: string; custom_id?: string; invoice_id?: string } };
    const milestone = resource?.invoice_id ? await db.get<{ pact_id: string }>('SELECT pact_id FROM milestones WHERE id = ?', resource.invoice_id) : undefined;
    const pactId = milestone?.pact_id ?? resource?.custom_id;
    if (pactId && await E.getPact(pactId)) {
      await record({ pact_id: pactId, milestone_id: resource?.invoice_id ?? null, type: 'WEBHOOK', actor: 'paypal', paypal_ref: resource?.id, detail: event_type });
    }
    res.json({ ok: true });
  }));

  r.use((err: Error, _q: Request, res: Response, _n: NextFunction) => {
    if (err instanceof z.ZodError) return void res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err instanceof LimitReached) return void res.status(429).json({ error: err.message });
    if (err instanceof NotFound) return void res.status(404).json({ error: err.message });
    if (err instanceof Forbidden) return void res.status(403).json({ error: err.message });
    if (err instanceof E.Conflict) return void res.status(409).json({ error: err.message });
    console.error(now(), err);
    res.status(500).json({ error: 'Something went wrong. No money moved unless the ledger shows it.' });
  });

  return r;
}

class NotFound extends Error {}
class Forbidden extends Error {}
