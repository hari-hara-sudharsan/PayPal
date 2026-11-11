import crypto from 'node:crypto';
import { db, type Arg } from '../db';
import { config } from '../config';
import { now } from '../clock';
import { record } from '../ledger';
import { feeFor, pctOf, toCents, toValue } from '../money';
import { approvalLink, authorizationOf, paypal, PayPalError } from '../paypal/client';
import { verifyDeliverable } from '../ai/verify';
import { holdTribunal } from '../ai/tribunal';
import type { Draft } from '../ai/draft';
import { modelName } from '../ai/llm';
import type { Milestone, MilestoneStatus, Pact, Role, TribunalStep, Verification } from '../types';

export class Conflict extends Error {}

const DAY = 86_400_000;
const HONOR_DAYS = 3;
const AUTH_DAYS = 29;
const MIN_JUDGE_CONFIDENCE = 0.6;
/** Longer than the longest a function may run, so anything older has lost its owner. */
const STALE_AFTER_MS = 5.5 * 60_000;
/** States a milestone can never leave. */
const TERMINAL: MilestoneStatus[] = ['RELEASED', 'FORFEITED'];
/** States owned by a running request. */
const IN_FLIGHT: MilestoneStatus[] = ['VERIFYING', 'IN_TRIBUNAL', 'RELEASING'];

const rowToMilestone = (r: Record<string, unknown>): Milestone =>
  ({ ...r, criteria: JSON.parse(r.criteria as string) }) as unknown as Milestone;

export const getPact = (id: string) => db.get<Pact>('SELECT * FROM pacts WHERE id = ?', id);

/**
 * Once real PayPal is connected, pacts funded by the emulator are left out: their references
 * mean nothing to PayPal, so they are neither listed nor sent to it. Nothing is deleted.
 */
export const REAL_ONLY = config.paypal.mode === 'sandbox' ? ` AND COALESCE(p.auth_id, '') NOT LIKE 'SIM%'` : '';

export const listPacts = () => db.all<Pact>(`SELECT p.* FROM pacts p WHERE 1 = 1${REAL_ONLY} ORDER BY p.created_at DESC LIMIT 100`);

export const milestonesOf = async (pactId: string) =>
  (await db.all<Record<string, unknown>>('SELECT * FROM milestones WHERE pact_id = ? ORDER BY idx', pactId)).map(rowToMilestone);

export async function getMilestone(id: string): Promise<Milestone> {
  const row = await db.get<Record<string, unknown>>('SELECT * FROM milestones WHERE id = ?', id);
  if (!row) throw new Conflict('Milestone not found');
  return rowToMilestone(row);
}

export const verificationsOf = async (milestoneId: string) =>
  (await db.all<Record<string, unknown>>('SELECT * FROM verifications WHERE milestone_id = ? ORDER BY attempt', milestoneId))
    .map((r) => ({ ...r, results: JSON.parse(r.results as string), shield: JSON.parse(r.shield as string) })) as unknown as Verification[];

export const tribunalOf = (milestoneId: string) =>
  db.all<TribunalStep>('SELECT * FROM tribunal_steps WHERE milestone_id = ? ORDER BY seq', milestoneId);

/**
 * Compare-and-set on status. Two concurrent requests can both read PASSED, but only one
 * update matches, so a milestone can never be released twice.
 */
async function transition(id: string, from: MilestoneStatus[], to: MilestoneStatus, extra: Record<string, Arg> = {}) {
  const fields = { ...extra, locked_at: IN_FLIGHT.includes(to) ? now() : null };
  const sets = ['status = ?', ...Object.keys(fields).map((k) => `${k} = ?`)].join(', ');
  const marks = from.map(() => '?').join(',');
  const { changes } = await db.run(`UPDATE milestones SET ${sets} WHERE id = ? AND status IN (${marks})`,
    to, ...Object.values(fields), id, ...from);
  if (changes !== 1) throw new Conflict(`Milestone is not in a state that allows this (needs ${from.join(' or ')})`);
}

const setPact = (id: string, fields: Record<string, Arg>) => {
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  return db.run(`UPDATE pacts SET ${sets} WHERE id = ?`, ...Object.values(fields), id);
};

// ---- Creating and signing -------------------------------------------------

export interface NewPact {
  draft: Draft; buyer_email: string; worker_email: string; source_text: string;
  challenge_seconds?: number; auto_release_max?: number; ai_arbitration?: boolean;
}

export async function createPact(input: NewPact): Promise<Pact> {
  const { draft } = input;
  if (!draft.milestones.length) throw new Conflict('A pact needs at least one milestone');
  const id = `pact_${crypto.randomBytes(5).toString('hex')}`;
  const key = () => crypto.randomBytes(18).toString('base64url');
  const at = now();

  const milestones = draft.milestones.map((m, idx) => ({
    id: `ms_${crypto.randomBytes(5).toString('hex')}`, idx, title: m.title, amount_cents: toCents(m.amount),
    due_at: m.due_days == null ? null : at + m.due_days * DAY,
    criteria: m.criteria.map((c, i) => ({ id: `c${idx + 1}.${i + 1}`, text: c.text, kind: c.kind, arg: c.arg })),
  }));
  if (milestones.some((m) => m.amount_cents <= 0)) throw new Conflict('Every milestone needs an amount above zero');
  if (milestones.some((m) => !m.criteria.length)) throw new Conflict('Every milestone needs at least one acceptance criterion');
  const total = milestones.reduce((s, m) => s + m.amount_cents, 0);

  const terms = JSON.stringify({ title: draft.title, currency: draft.currency, milestones });
  const pact = {
    id, title: draft.title, summary: draft.summary, currency: draft.currency.toUpperCase(), total_cents: total,
    buyer_name: draft.buyer_name, buyer_email: input.buyer_email, worker_name: draft.worker_name, worker_email: input.worker_email,
    buyer_key: key(), worker_key: key(), terms_hash: crypto.createHash('sha256').update(terms).digest('hex'),
    status: 'AWAITING_SIGNATURE', challenge_seconds: input.challenge_seconds ?? 86_400,
    auto_release_max_cents: toCents(input.auto_release_max ?? 500), ai_arbitration: input.ai_arbitration === false ? 0 : 1,
    source_text: input.source_text, created_at: at,
  };
  const cols = Object.keys(pact);
  await db.run(`INSERT INTO pacts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...(Object.values(pact) as Arg[]));
  for (const m of milestones) {
    await db.run('INSERT INTO milestones (id, pact_id, idx, title, amount_cents, due_at, criteria, status) VALUES (?,?,?,?,?,?,?,?)',
      m.id, id, m.idx, m.title, m.amount_cents, m.due_at, JSON.stringify(m.criteria), 'OPEN');
  }
  await record({ pact_id: id, type: 'PACT_CREATED', actor: 'buyer', amount_cents: total, detail: `Terms hash ${pact.terms_hash.slice(0, 16)}` });
  return (await getPact(id))!;
}

export async function signPact(pact: Pact) {
  if (pact.status !== 'AWAITING_SIGNATURE') throw new Conflict('This pact has already been signed');
  await setPact(pact.id, { status: 'AWAITING_FUNDS', signed_at: now() });
  await record({ pact_id: pact.id, type: 'PACT_SIGNED', actor: 'worker', detail: `Accepted terms ${pact.terms_hash.slice(0, 16)}` });
}

// ---- Funding: PayPal authorization holds the money ------------------------

export async function createFundingOrder(pact: Pact) {
  if (pact.status !== 'AWAITING_FUNDS') throw new Conflict('This pact is not ready for funding');
  const order = await paypal.createOrder({ pactId: pact.id, description: pact.title, cents: pact.total_cents, currency: pact.currency });
  await setPact(pact.id, { order_id: order.id });
  await record({ pact_id: pact.id, type: 'ORDER_CREATED', actor: 'system', amount_cents: pact.total_cents, paypal_ref: order.id });
  return { orderId: order.id, approveUrl: approvalLink(order) };
}

export async function completeFunding(pact: Pact, orderId: string) {
  if (pact.status === 'ACTIVE') return;
  if (pact.status !== 'AWAITING_FUNDS' || pact.order_id !== orderId) throw new Conflict('This order does not belong to this pact');
  const auth = authorizationOf(await paypal.authorizeOrder(orderId));
  if (!auth) throw new Conflict('PayPal returned no authorization');
  const at = now();
  await setPact(pact.id, {
    status: 'ACTIVE', auth_id: auth.id, funded_at: at, honor_expires_at: at + HONOR_DAYS * DAY,
    auth_expires_at: auth.expiration_time ? Date.parse(auth.expiration_time) : at + AUTH_DAYS * DAY,
  });
  await record({ pact_id: pact.id, type: 'FUNDS_HELD', actor: 'buyer', amount_cents: pact.total_cents, paypal_ref: auth.id, detail: 'PayPal authorization placed. Nothing has been charged.' });
}

// ---- Delivery and verification ---------------------------------------------

export async function submitWork(milestoneId: string, text: string, url: string | null) {
  const m = await getMilestone(milestoneId);
  const pact = await getPact(m.pact_id);
  if (pact?.status !== 'ACTIVE') throw new Conflict('Funds must be held before work can be submitted');
  await transition(m.id, ['OPEN', 'FAILED', 'HELD'], 'VERIFYING');
  const attempt = (await verificationsOf(m.id)).length + 1;
  await record({ pact_id: pact.id, milestone_id: m.id, type: 'WORK_SUBMITTED', actor: 'worker', detail: `Attempt ${attempt}` });

  const v = await verifyDeliverable(m, attempt, text, url);
  await db.run('INSERT INTO verifications VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    v.id, v.milestone_id, v.attempt, v.deliverable_text, v.deliverable_url, v.outcome,
    JSON.stringify(v.results), JSON.stringify(v.shield), v.summary, v.model, v.created_at);

  if (v.shield.length) {
    await record({ pact_id: pact.id, milestone_id: m.id, type: 'SHIELD_ALERT', actor: 'shield', detail: v.shield.map((s) => s.technique).join('; ').slice(0, 240) });
  }
  const next = { PASS: 'PASSED', FAIL: 'FAILED', HOLD: 'HELD' }[v.outcome] as MilestoneStatus;
  const release_at = v.outcome === 'PASS' ? now() + pact.challenge_seconds * 1000 : null;
  await transition(m.id, ['VERIFYING'], next, { release_at });
  await record({ pact_id: pact.id, milestone_id: m.id, type: `VERIFIED_${v.outcome}`, actor: `ai:${v.model}`, amount_cents: m.amount_cents, detail: v.summary });
  return v;
}

// ---- Settlement: the only path that moves money ----------------------------

/**
 * The award is checked here against the contract, whoever or whatever proposed it.
 * Every PayPal call uses a request id derived from the milestone, so a crash and retry
 * replays the same operation and cannot pay twice.
 */
export async function settle(milestoneId: string, awardCents: number, actor: string, reason: string, from: MilestoneStatus[]) {
  const m = await getMilestone(milestoneId);
  const pact = (await getPact(m.pact_id))!;
  if (!Number.isInteger(awardCents) || awardCents < 0 || awardCents > m.amount_cents) {
    throw new Conflict(`Award of ${awardCents} is outside this milestone's ${m.amount_cents} cents`);
  }
  if (pact.captured_cents + awardCents > pact.total_cents) throw new Conflict('Award would exceed the funds held');

  await transition(m.id, from, 'RELEASING', { awarded_cents: awardCents, release_at: null });
  if (awardCents === 0) {
    await transition(m.id, ['RELEASING'], 'FORFEITED');
    await record({ pact_id: pact.id, milestone_id: m.id, type: 'NOT_AWARDED', actor, amount_cents: 0, detail: reason });
    return closeIfDone(pact.id);
  }
  await executeMoney(m.id, actor, reason);
}

/** The account itself cannot send Payouts, so retrying is pointless. */
const isPayoutRailClosed = (err: unknown) =>
  err instanceof PayPalError && (err.body as { name?: string } | null)?.name === 'PAYOUT_NOT_AVAILABLE';

async function executeMoney(milestoneId: string, actor: string, reason: string) {
  const m = await getMilestone(milestoneId);
  const pact = (await getPact(m.pact_id))!;
  const award = m.awarded_cents!;
  let captureId = m.capture_id;

  try {
    if (!captureId) {
      await record({ pact_id: pact.id, milestone_id: m.id, type: 'CAPTURE_INTENT', actor, amount_cents: award, detail: reason });
      const capture = await paypal.capture(pact.auth_id!, {
        cents: award, currency: pact.currency, invoiceId: m.id, note: `${pact.title}: ${m.title}`, requestId: `cap-${m.id}`,
      });
      captureId = capture.id;
      await db.run('UPDATE milestones SET capture_id = ? WHERE id = ?', captureId, m.id);
      await db.run('UPDATE pacts SET captured_cents = captured_cents + ? WHERE id = ?', award, pact.id);
      await record({ pact_id: pact.id, milestone_id: m.id, type: 'CAPTURED', actor: 'paypal', amount_cents: award, paypal_ref: captureId });
    }
    const fee = feeFor(award, config.feeBps);
    const payout = await paypal.payout({
      // Attempt in the id: a retry after a bounce must be a new payout, not a replay of the failed one.
      batchId: `pact-${m.id}-${m.payout_attempt ?? 0}`, cents: award - fee, currency: pact.currency, receiver: pact.worker_email,
      note: `${pact.title}: ${m.title}`, itemId: m.id,
    });
    const payoutId = payout.batch_header.payout_batch_id;
    await transition(m.id, ['RELEASING', 'PAYOUT_FAILED'], 'RELEASED', { payout_id: payoutId, payout_status: null });
    await record({ pact_id: pact.id, milestone_id: m.id, type: 'PAID_OUT', actor: 'paypal', amount_cents: award - fee, paypal_ref: payoutId, detail: `To ${pact.worker_email}` });
    if (fee && !m.payout_attempt) await record({ pact_id: pact.id, milestone_id: m.id, type: 'PLATFORM_FEE', actor: 'system', amount_cents: fee, detail: `${config.feeBps / 100}%` });
  } catch (err) {
    if (captureId && isPayoutRailClosed(err)) {
      const fee = feeFor(award, config.feeBps);
      await transition(m.id, ['RELEASING', 'PAYOUT_FAILED'], 'RELEASED', { payout_status: 'OWED' });
      await record({ pact_id: pact.id, milestone_id: m.id, type: 'PAYOUT_OWED', actor: 'paypal', amount_cents: award - fee, detail: 'PayPal does not allow this account to send Payouts. The capture stands, and this amount is owed to the worker.' });
      if (fee && !m.payout_attempt) await record({ pact_id: pact.id, milestone_id: m.id, type: 'PLATFORM_FEE', actor: 'system', amount_cents: fee, detail: `${config.feeBps / 100}%` });
      return closeIfDone(pact.id);
    }
    const stage = captureId ? 'PAYOUT_FAILED' : 'CAPTURE_FAILED';
    await record({ pact_id: pact.id, milestone_id: m.id, type: stage, actor: 'paypal', amount_cents: award, detail: (err as Error).message.slice(0, 240) });
    // A failed capture moved nothing, so the case returns for a person. A failed payout keeps
    // the capture and can be retried safely.
    await db.run('UPDATE milestones SET status = ?, locked_at = NULL WHERE id = ?', captureId ? 'PAYOUT_FAILED' : 'HELD', m.id);
    if (err instanceof PayPalError) throw new Conflict(err.message);
    throw err;
  }
  await closeIfDone(pact.id);
}

export const retryPayout = async (milestoneId: string) => {
  const m = await getMilestone(milestoneId);
  if (m.status !== 'PAYOUT_FAILED') throw new Conflict('There is no failed payout to retry');
  await executeMoney(m.id, 'system', 'Retry after a failed payout');
};

/** When every milestone is decided, the unearned balance of the hold goes back to the buyer. */
async function closeIfDone(pactId: string) {
  const pact = (await getPact(pactId))!;
  if (pact.status !== 'ACTIVE') return;
  if (!(await milestonesOf(pactId)).every((m) => TERMINAL.includes(m.status))) return;
  const remaining = pact.total_cents - pact.captured_cents;
  if (remaining > 0) {
    await paypal.void(pact.auth_id!, `void-${pact.id}`);
    await record({ pact_id: pactId, type: 'HOLD_RELEASED', actor: 'paypal', amount_cents: remaining, paypal_ref: pact.auth_id, detail: 'Unearned balance returned. It was never charged.' });
  }
  await setPact(pactId, { status: 'SETTLED' });
  await record({ pact_id: pactId, type: 'PACT_SETTLED', actor: 'system', amount_cents: pact.captured_cents, detail: `Paid ${toValue(pact.captured_cents)} of ${toValue(pact.total_cents)}` });
}

/** Buyer decides. They may always choose to pay, including over a failed or held review. */
export const approve = async (milestoneId: string) => {
  const m = await getMilestone(milestoneId);
  return settle(m.id, m.amount_cents, 'buyer', 'Buyer approved the work', ['PASSED', 'FAILED', 'HELD', 'ESCALATED']);
};

export async function forfeit(milestoneId: string, actor: Role) {
  const m = await getMilestone(milestoneId);
  if (actor === 'buyer' && !(m.due_at && now() > m.due_at)) throw new Conflict('A buyer can only cancel a milestone after its due date');
  await settle(m.id, 0, actor, actor === 'worker' ? 'Worker withdrew from this milestone' : 'Buyer cancelled an overdue milestone', ['OPEN', 'FAILED', 'HELD', 'ESCALATED']);
}

// ---- Disputes --------------------------------------------------------------

export async function contest(milestoneId: string, by: Role, statement: string) {
  const m = await getMilestone(milestoneId);
  const pact = (await getPact(m.pact_id))!;
  if (!pact.ai_arbitration) throw new Conflict('This pact does not use AI arbitration');
  const allowed: MilestoneStatus[] = by === 'buyer' ? ['PASSED', 'HELD'] : ['FAILED', 'HELD'];
  await transition(m.id, allowed, 'CONTESTED', {
    contest_by: by, contest_statement: statement, release_at: null,
    convene_at: now() + pact.challenge_seconds * 1000,
  });
  await record({ pact_id: pact.id, milestone_id: m.id, type: 'DISPUTE_OPENED', actor: by, amount_cents: m.amount_cents, detail: statement.slice(0, 200) });
}

/** Files the answer. The caller then convenes, so a serverless host can run the hearing after replying. */
export async function fileResponse(milestoneId: string, by: Role, statement: string) {
  const m = await getMilestone(milestoneId);
  if (m.status !== 'CONTESTED') throw new Conflict('There is no open dispute on this milestone');
  if (m.contest_by === by) throw new Conflict('Only the other party can respond');
  await db.run('UPDATE milestones SET response_statement = ? WHERE id = ?', statement, m.id);
  await record({ pact_id: m.pact_id, milestone_id: m.id, type: 'DISPUTE_RESPONSE', actor: by, detail: statement.slice(0, 200) });
}

/** A hearing stopped by an AI outage decided nothing, so either party may run it again. */
export async function reopenHearing(milestoneId: string) {
  await transition(milestoneId, ['ESCALATED'], 'CONTESTED', { convene_at: now() });
  await db.run('DELETE FROM tribunal_steps WHERE milestone_id = ?', milestoneId);
}

/** `resume` continues a hearing whose earlier run was cut off; the caller has already claimed it. */
export async function convene(milestoneId: string, resume = false) {
  if (!resume) await transition(milestoneId, ['CONTESTED'], 'IN_TRIBUNAL');
  const m = await getMilestone(milestoneId);
  const pact = (await getPact(m.pact_id))!;
  const verification = (await verificationsOf(m.id)).at(-1) ?? null;
  if (!resume) await record({ pact_id: pact.id, milestone_id: m.id, type: 'TRIBUNAL_CONVENED', actor: 'system', amount_cents: m.amount_cents });

  // A ruling only counts once its verdict is recorded, so an unrecorded one is argued again.
  await db.run(`DELETE FROM tribunal_steps WHERE milestone_id = ? AND speaker = 'judge'`, m.id);
  const done = await tribunalOf(m.id);

  let ruling;
  try {
    ruling = await holdTribunal({ pact, milestone: m, verification }, done, async (s) => {
      await db.run('INSERT INTO tribunal_steps VALUES (?,?,?,?,?,?,?,?)', s.id, s.milestone_id, s.seq, s.speaker, s.round, s.text, s.model, s.created_at);
      await record({ pact_id: pact.id, milestone_id: m.id, type: 'TRIBUNAL_STEP', actor: s.speaker, detail: s.round });
    });
  } catch (err) {
    await transition(m.id, ['IN_TRIBUNAL'], 'ESCALATED');
    await record({ pact_id: pact.id, milestone_id: m.id, type: 'ESCALATED', actor: 'system', detail: `Tribunal could not finish: ${(err as Error).message.slice(0, 160)}` });
    return;
  }

  if (ruling.confidence < MIN_JUDGE_CONFIDENCE) {
    await transition(m.id, ['IN_TRIBUNAL'], 'ESCALATED');
    await record({ pact_id: pact.id, milestone_id: m.id, type: 'ESCALATED', actor: `ai:${modelName()}`, detail: `Judge confidence ${ruling.confidence} is below ${MIN_JUDGE_CONFIDENCE}. A person must decide.` });
    return;
  }
  const award = pctOf(m.amount_cents, ruling.award_pct);
  await record({ pact_id: pact.id, milestone_id: m.id, type: 'VERDICT', actor: `ai:${modelName()}`, amount_cents: award, detail: `${ruling.award_pct}% to worker. ${ruling.ruling}`.slice(0, 400) });
  await settle(m.id, award, 'tribunal', `Tribunal awarded ${ruling.award_pct}%`, ['IN_TRIBUNAL']);
}

// ---- Payout confirmation ---------------------------------------------------

const PAYOUT_FAILED_STATES = ['FAILED', 'RETURNED', 'BLOCKED', 'DENIED', 'REFUNDED', 'REVERSED'];

/** PayPal settles a payout after accepting it, so the ledger only says confirmed once it has. */
async function confirmPayouts(pactId?: string) {
  const pending = await db.all<{ id: string; pact_id: string; payout_id: string; payout_status: string | null; awarded_cents: number }>(
    `SELECT id, pact_id, payout_id, payout_status, awarded_cents FROM milestones
     WHERE status = 'RELEASED' AND payout_id IS NOT NULL
       AND (payout_status IS NULL OR payout_status IN ('PENDING', 'PROCESSING', 'ONHOLD', 'NEW'))${pactId ? ' AND pact_id = ?' : ''}
       AND pact_id IN (SELECT p.id FROM pacts p WHERE 1 = 1${REAL_ONLY})`,
    ...(pactId ? [pactId] : []));

  for (const m of pending) {
    try {
      const report = await paypal.payoutStatus(m.payout_id);
      const item = report.items?.[0];
      const state = item?.transaction_status ?? report.batch_header.batch_status;
      if (state === (m.payout_status ?? '')) continue;
      const failed = PAYOUT_FAILED_STATES.includes(state);

      // Compare-and-set, so only one of several overlapping polls writes the ledger.
      const { changes } = await db.run(
        `UPDATE milestones SET payout_status = ?, status = ?, payout_id = ?, payout_attempt = payout_attempt + ?
         WHERE id = ? AND payout_id = ? AND COALESCE(payout_status, '') = ?`,
        state, failed ? 'PAYOUT_FAILED' : 'RELEASED', failed ? null : m.payout_id, failed ? 1 : 0, m.id, m.payout_id, m.payout_status ?? '');
      if (changes !== 1) continue;

      if (failed) {
        const net = m.awarded_cents - feeFor(m.awarded_cents, config.feeBps);
        await record({ pact_id: m.pact_id, milestone_id: m.id, type: 'PAYOUT_REVERSED', actor: 'paypal', amount_cents: net, paypal_ref: m.payout_id, detail: item?.errors?.message ?? state });
      } else if (state === 'SUCCESS') {
        await record({ pact_id: m.pact_id, milestone_id: m.id, type: 'PAYOUT_CONFIRMED', actor: 'paypal', paypal_ref: m.payout_id });
      } else if (state === 'UNCLAIMED') {
        await record({ pact_id: m.pact_id, milestone_id: m.id, type: 'PAYOUT_UNCLAIMED', actor: 'paypal', paypal_ref: m.payout_id, detail: 'Waiting for the worker to claim it at PayPal' });
      }
    } catch (err) {
      console.error('payout status', m.id, (err as Error).message);
    }
  }
}

// ---- Time-based work -------------------------------------------------------

/**
 * Serverless has no always-on process, so this runs when a page polls a pact, from a daily cron,
 * and on a timer when self-hosted. Every step is a compare-and-set or uses a stable PayPal
 * request id, so overlapping runs are safe, and each item is isolated from the rest.
 */
export async function sweep(pactId?: string) {
  const at = now();
  const scope = (pactId ? ' AND p.id = ?' : '') + REAL_ONLY;
  const args = pactId ? [pactId] : [];

  // In-flight work older than any function can live has lost its owner. A review goes to a
  // person, a hearing starts over, and a settlement becomes a retry, which is safe even if
  // the capture already went through.
  const stuck = await db.all<{ id: string; pact_id: string; status: MilestoneStatus; locked_at: number }>(
    `SELECT m.id, m.pact_id, m.status, m.locked_at FROM milestones m JOIN pacts p ON p.id = m.pact_id
     WHERE m.status IN ('VERIFYING', 'IN_TRIBUNAL', 'RELEASING') AND m.locked_at < ?${scope}`, at - STALE_AFTER_MS, ...args);
  for (const m of stuck) {
    try {
      if (m.status === 'VERIFYING') await transition(m.id, ['VERIFYING'], 'HELD');
      if (m.status === 'RELEASING') await transition(m.id, ['RELEASING'], 'PAYOUT_FAILED');
      if (m.status === 'IN_TRIBUNAL') {
        // Claim it by its old lock time, so only one of several polling pages resumes it.
        const { changes } = await db.run(`UPDATE milestones SET locked_at = ? WHERE id = ? AND status = 'IN_TRIBUNAL' AND locked_at = ?`, at, m.id, m.locked_at);
        if (changes !== 1) continue;
        await record({ pact_id: m.pact_id, milestone_id: m.id, type: 'RECOVERED', actor: 'system', detail: 'Hearing resumed where it stopped' });
        await convene(m.id, true);
        continue;
      }
      await record({ pact_id: m.pact_id, milestone_id: m.id, type: 'RECOVERED', actor: 'system', detail: `Timed out while ${m.status}` });
    } catch (err) {
      if (!(err instanceof Conflict)) console.error('recover', m.id, (err as Error).message);
    }
  }

  const due = await db.all<{ id: string; status: string; amount_cents: number; release_at: number | null; convene_at: number | null; auto_release_max_cents: number }>(
    `SELECT m.id, m.status, m.amount_cents, m.release_at, m.convene_at, p.auto_release_max_cents
     FROM milestones m JOIN pacts p ON p.id = m.pact_id
     WHERE p.status = 'ACTIVE' AND m.status IN ('PASSED', 'CONTESTED')${scope}`, ...args);

  for (const m of due) {
    try {
      if (m.status === 'PASSED' && m.release_at && at >= m.release_at && m.amount_cents <= m.auto_release_max_cents) {
        await settle(m.id, m.amount_cents, 'system', 'Verified, and the challenge window closed with no dispute', ['PASSED']);
      } else if (m.status === 'CONTESTED' && m.convene_at && at >= m.convene_at) {
        await convene(m.id);
      }
    } catch (err) {
      if (!(err instanceof Conflict)) console.error('sweep', m.id, (err as Error).message);
    }
  }

  await confirmPayouts(pactId);

  // Past PayPal's honor period a capture is less certain, so renew the hold on what is left.
  const stale = await db.all<Pact>(`SELECT p.* FROM pacts p WHERE p.status = 'ACTIVE' AND p.honor_expires_at < ?${scope}`, at, ...args);
  for (const pact of stale) {
    const remaining = pact.total_cents - pact.captured_cents;
    try {
      const next = await paypal.reauthorize(pact.auth_id!, remaining, pact.currency, `reauth-${pact.auth_id}`);
      await setPact(pact.id, { auth_id: next.id, honor_expires_at: at + HONOR_DAYS * DAY });
      await record({ pact_id: pact.id, type: 'HOLD_RENEWED', actor: 'system', amount_cents: remaining, paypal_ref: next.id });
    } catch (err) {
      // Pushed out a day so a refusal does not repeat on every poll.
      await setPact(pact.id, { honor_expires_at: at + DAY });
      await record({ pact_id: pact.id, type: 'HOLD_RENEWAL_FAILED', actor: 'paypal', amount_cents: remaining, detail: (err as Error).message.slice(0, 200) });
    }
  }
}
