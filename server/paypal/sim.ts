import crypto from 'node:crypto';
import { Router, json, type Request, type Response } from 'express';
import { db } from '../db';
import { config } from '../config';
import { now } from '../clock';
import { toCents } from '../money';

/**
 * Local emulator of the PayPal REST endpoints Pact uses, so the app runs with zero credentials.
 * The real client in client.ts drives it over HTTP, and it enforces the rules that matter:
 * capture limits, idempotent replays, no void after full capture. It never touches PayPal.
 */
const get = <T>(k: string) => {
  const row = db.prepare('SELECT v FROM sim_kv WHERE k = ?').get(k) as { v: string } | undefined;
  return row ? JSON.parse(row.v) as T : undefined;
};
const put = (k: string, v: unknown) =>
  db.prepare('INSERT INTO sim_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));

interface SimOrder { id: string; status: string; cents: number; currency: string; authId?: string }
interface SimAuth { id: string; orderId: string; cents: number; captured: number; currency: string; status: string; createdAt: number }
type Out = { status: number; body: unknown };

const DAY = 86_400_000;
const id = (p: string) => `${p}${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
const fail = (issue: string): Out => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue }], message: issue } });
const missing: Out = { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } };

/** Same contract as PayPal: repeat a PayPal-Request-Id and you get the first response back. */
const idem = (handler: (req: Request) => Out) => (req: Request, res: Response) => {
  const key = req.get('PayPal-Request-Id');
  const seen = key ? get<Out>(`idem:${key}`) : undefined;
  if (seen) return void res.status(seen.status).json(seen.body);
  const out = handler(req);
  if (key && out.status < 400) put(`idem:${key}`, out);
  res.status(out.status).json(out.body);
};

export function simRouter() {
  const r = Router();
  r.use(json());

  r.post('/v1/oauth2/token', (_q, s) => { s.json({ access_token: id('SIMTOKEN'), expires_in: 32400 }); });

  r.post('/v2/checkout/orders', idem((req) => {
    const pu = req.body.purchase_units[0];
    const order: SimOrder = { id: id('SIMORD'), status: 'CREATED', cents: toCents(pu.amount.value), currency: pu.amount.currency_code };
    put(`order:${order.id}`, order);
    return { status: 201, body: { id: order.id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `${config.publicUrl}/sim-checkout/${order.id}?pact=${pu.reference_id}` }] } };
  }));

  // Stands in for the buyer logging in and approving on paypal.com.
  r.post('/sim/approve/:id', (req, res) => {
    const order = get<SimOrder>(`order:${req.params.id}`);
    if (!order) return void res.status(404).json({ name: 'RESOURCE_NOT_FOUND' });
    put(`order:${order.id}`, { ...order, status: 'APPROVED' });
    res.json({ status: 'APPROVED' });
  });

  r.post('/v2/checkout/orders/:id/authorize', idem((req) => {
    const order = get<SimOrder>(`order:${req.params.id}`);
    if (!order) return missing;
    if (order.status !== 'APPROVED') return fail('ORDER_NOT_APPROVED');
    const auth: SimAuth = { id: id('SIMAUTH'), orderId: order.id, cents: order.cents, captured: 0, currency: order.currency, status: 'CREATED', createdAt: now() };
    put(`auth:${auth.id}`, auth);
    put(`order:${order.id}`, { ...order, status: 'COMPLETED', authId: auth.id });
    return { status: 201, body: { id: order.id, status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{
      id: auth.id, status: 'CREATED', expiration_time: new Date(auth.createdAt + 29 * DAY).toISOString(),
    }] } }] } };
  }));

  r.post('/v2/payments/authorizations/:id/capture', idem((req) => {
    const auth = get<SimAuth>(`auth:${req.params.id}`);
    if (!auth) return missing;
    if (auth.status === 'VOIDED') return fail('AUTHORIZATION_VOIDED');
    if (now() > auth.createdAt + 29 * DAY) return fail('AUTHORIZATION_EXPIRED');
    const cents = toCents(req.body.amount.value);
    if (auth.captured + cents > auth.cents) return fail('MAX_CAPTURE_AMOUNT_EXCEEDED');
    const captured = auth.captured + cents;
    put(`auth:${auth.id}`, { ...auth, captured, status: captured === auth.cents ? 'CAPTURED' : 'PARTIALLY_CAPTURED' });
    return { status: 201, body: { id: id('SIMCAP'), status: 'COMPLETED', amount: req.body.amount, final_capture: !!req.body.final_capture } };
  }));

  r.post('/v2/payments/authorizations/:id/void', idem((req) => {
    const auth = get<SimAuth>(`auth:${req.params.id}`);
    if (!auth) return missing;
    if (auth.status === 'CAPTURED') return fail('PREVIOUSLY_CAPTURED');
    put(`auth:${auth.id}`, { ...auth, status: 'VOIDED' });
    return { status: 200, body: { id: auth.id, status: 'VOIDED' } };
  }));

  r.post('/v2/payments/authorizations/:id/reauthorize', idem((req) => {
    const auth = get<SimAuth>(`auth:${req.params.id}`);
    if (!auth) return missing;
    if (auth.status === 'VOIDED') return fail('AUTHORIZATION_VOIDED');
    const next: SimAuth = { ...auth, id: id('SIMAUTH'), cents: toCents(req.body.amount.value), captured: 0, status: 'CREATED' };
    put(`auth:${next.id}`, next);
    put(`auth:${auth.id}`, { ...auth, status: 'VOIDED' });
    return { status: 201, body: { id: next.id, status: 'CREATED', expiration_time: new Date(auth.createdAt + 29 * DAY).toISOString() } };
  }));

  r.post('/v1/payments/payouts', idem((req) => {
    const item = req.body.items[0];
    if (String(item.receiver).includes('fail-payout')) return fail('RECEIVER_UNREGISTERED');
    return { status: 201, body: { batch_header: { payout_batch_id: id('SIMPAY'), batch_status: 'PENDING' } } };
  }));

  return r;
}
