import crypto from 'node:crypto';
import { db } from '../db';
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
/** States a milestone can never leave. */
const TERMINAL: MilestoneStatus[] = ['RELEASED', 'FORFEITED'];

const rowToMilestone = (r: Record<string, unknown>): Milestone =>
  ({ ...r, criteria: JSON.parse(r.criteria as string) }) as unknown as Milestone;

export const getPact = (id: string) => db.prepare('SELECT * FROM pacts WHERE id = ?').get(id) as unknown as Pact | undefined;

export const listPacts = () => db.prepare('SELECT * FROM pacts ORDER BY created_at DESC LIMIT 100').all() as unknown as Pact[];

export const milestonesOf = (pactId: string) =>
  (db.prepare('SELECT * FROM milestones WHERE pact_id = ? ORDER BY idx').all(pactId) as Record<string, unknown>[]).map(rowToMilestone);

export function getMilestone(id: string): Milestone {
  const row = db.prepare('SELECT * FROM milestones WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Conflict('Milestone not found');
  return rowToMilestone(row);
}

export const verificationsOf = (milestoneId: string) =>
  (db.prepare('SELECT * FROM verifications WHERE milestone_id = ? ORDER BY attempt').all(milestoneId) as Record<string, unknown>[])
    .map((r) => ({ ...r, results: JSON.parse(r.results as string), shield: JSON.parse(r.shield as string) })) as unknown as Verification[];

export const tribunalOf = (milestoneId: string) =>
  db.prepare('SELECT * FROM tribunal_steps WHERE milestone_id = ? ORDER BY seq').all(milestoneId) as unknown as TribunalStep[];

/**
 * Compare-and-set on status. Two concurrent requests can both read PASSED, but only one
 * update matches, so a milestone can never be released twice.
 */
function transition(id: string, from: MilestoneStatus[], to: MilestoneStatus, extra: Record<string, unknown> = {}) {
  const sets = ['status = ?', ...Object.keys(extra).map((k) => `${k} = ?`)].join(', ');
  const marks = from.map(() => '?').join(',');
  const { changes } = db.prepare(`UPDATE milestones SET ${sets} WHERE id = ? AND status IN (${marks})`)
    .run(to, ...(Object.values(extra) as (string | number | null)[]), id, ...from);
  if (Number(changes) !== 1) throw new Conflict(`Milestone is not in a state that allows this (needs ${from.join(' or ')})`);
}

const setPact = (id: string, fields: Record<string, string | number | null>) => {
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE pacts SET ${sets} WHERE id = ?`).run(...Object.values(fields), id);
};

// ---- Creating and signing -------------------------------------------------

export interface NewPact {
  draft: Draft; buyer_email: string; worker_email: string; source_text: string;
  challenge_seconds?: number; auto_release_max?: number; ai_arbitration?: boolean;
}

export function createPact(input: NewPact): Pact {
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
  db.prepare(`INSERT INTO pacts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(Object.values(pact) as (string | number)[]));
  for (const m of milestones) {
    db.prepare('INSERT INTO milestones (id, pact_id, idx, title, amount_cents, due_at, criteria, status) VALUES (?,?,?,?,?,?,?,?)')
      .run(m.id, id, m.idx, m.title, m.amount_cents, m.due_at, JSON.stringify(m.criteria), 'OPEN');
  }
  record({ pact_id: id, type: 'PACT_CREATED', actor: 'buyer', amount_cents: total, detail: `Terms hash ${pact.terms_hash.slice(0, 16)}` });
  return getPact(id)!;
}

export function signPact(pact: Pact) {
  if (pact.status !== 'AWAITING_SIGNATURE') throw new Conflict('This pact has already been signed');
  setPact(pact.id, { status: 'AWAITING_FUNDS', signed_at: now() });
  record({ pact_id: pact.id, type: 'PACT_SIGNED', actor: 'worker', detail: `Accepted terms ${pact.terms_hash.slice(0, 16)}` });
}

// ---- Funding: PayPal authorization holds the money ------------------------

export async function createFundingOrder(pact: Pact) {
  if (pact.status !== 'AWAITING_FUNDS') throw new Conflict('This pact is not ready for funding');
  const order = await paypal.createOrder({ pactId: pact.id, description: pact.title, cents: pact.total_cents, currency: pact.currency });
  setPact(pact.id, { order_id: order.id });
  record({ pact_id: pact.id, type: 'ORDER_CREATED', actor: 'system', amount_cents: pact.total_cents, paypal_ref: order.id });
  return { orderId: order.id, approveUrl: approvalLink(order) };
}

export async function completeFunding(pact: Pact, orderId: string) {
  if (pact.status === 'ACTIVE') return;
  if (pact.status !== 'AWAITING_FUNDS' || pact.order_id !== orderId) throw new Conflict('This order does not belong to this pact');
  const auth = authorizationOf(await paypal.authorizeOrder(orderId));
  if (!auth) throw new Conflict('PayPal returned no authorization');
  const at = now();
  setPact(pact.id, {
    status: 'ACTIVE', auth_id: auth.id, funded_at: at, honor_expires_at: at + HONOR_DAYS * DAY,
    auth_expires_at: auth.expiration_time ? Date.parse(auth.expiration_time) : at + AUTH_DAYS * DAY,
  });
  record({ pact_id: pact.id, type: 'FUNDS_HELD', actor: 'buyer', amount_cents: pact.total_cents, paypal_ref: auth.id, detail: 'PayPal authorization placed. Nothing has been charged.' });
}

// ---- Delivery and verification ---------------------------------------------

const requireActive = (pactId: string) => {
  const pact = getPact(pactId);
  if (pact?.status !== 'ACTIVE') throw new Conflict('Funds must be held before work can be submitted');
  return pact;
};

export async function submitWork(milestoneId: string, text: string, url: string | null) {
  const m = getMilestone(milestoneId);
  const pact = requireActive(m.pact_id);
  transition(m.id, ['OPEN', 'FAILED', 'HELD'], 'VERIFYING');
  const attempt = verificationsOf(m.id).length + 1;
  record({ pact_id: pact.id, milestone_id: m.id, type: 'WORK_SUBMITTED', actor: 'worker', detail: `Attempt ${attempt}` });

  const v = await verifyDeliverable(m, attempt, text, url);
  db.prepare('INSERT INTO verifications VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    v.id, v.milestone_id, v.attempt, v.deliverable_text, v.deliverable_url, v.outcome,
    JSON.stringify(v.results), JSON.stringify(v.shield), v.summary, v.model, v.created_at);

  if (v.shield.length) {
    record({ pact_id: pact.id, milestone_id: m.id, type: 'SHIELD_ALERT', actor: 'shield', detail: v.shield.map((s) => s.technique).join('; ').slice(0, 240) });
  }
  const next = { PASS: 'PASSED', FAIL: 'FAILED', HOLD: 'HELD' }[v.outcome] as MilestoneStatus;
  const release_at = v.outcome === 'PASS' ? now() + pact.challenge_seconds * 1000 : null;
  transition(m.id, ['VERIFYING'], next, { release_at });
  record({ pact_id: pact.id, milestone_id: m.id, type: `VERIFIED_${v.outcome}`, actor: `ai:${v.model}`, amount_cents: m.amount_cents, detail: v.summary });
  return v;
}

// ---- Settlement: the only path that moves money ----------------------------

/**
 * The award is checked here against the contract, whoever or whatever proposed it.
 * Every PayPal call uses a request id derived from the milestone, so a crash and retry
 * replays the same operation and cannot pay twice.
 */
export async function settle(milestoneId: string, awardCents: number, actor: string, reason: string, from: MilestoneStatus[]) {
  const m = getMilestone(milestoneId);
  const pact = getPact(m.pact_id)!;
  if (!Number.isInteger(awardCents) || awardCents < 0 || awardCents > m.amount_cents) {
    throw new Conflict(`Award of ${awardCents} is outside this milestone's ${m.amount_cents} cents`);
  }
  if (pact.captured_cents + awardCents > pact.total_cents) throw new Conflict('Award would exceed the funds held');

  transition(m.id, from, 'RELEASING', { awarded_cents: awardCents, release_at: null });
  if (awardCents === 0) {
    transition(m.id, ['RELEASING'], 'FORFEITED');
    record({ pact_id: pact.id, milestone_id: m.id, type: 'NOT_AWARDED', actor, amount_cents: 0, detail: reason });
    return closeIfDone(pact.id);
  }
  await executeMoney(m.id, actor, reason);
}

async function executeMoney(milestoneId: string, actor: string, reason: string) {
  const m = getMilestone(milestoneId);
  const pact = getPact(m.pact_id)!;
  const award = m.awarded_cents!;
  let captureId = m.capture_id;

  try {
    if (!captureId) {
      record({ pact_id: pact.id, milestone_id: m.id, type: 'CAPTURE_INTENT', actor, amount_cents: award, detail: reason });
      const capture = await paypal.capture(pact.auth_id!, {
        cents: award, currency: pact.currency, invoiceId: m.id, note: `${pact.title}: ${m.title}`, requestId: `cap-${m.id}`,
      });
      captureId = capture.id;
      db.prepare('UPDATE milestones SET capture_id = ? WHERE id = ?').run(captureId, m.id);
      db.prepare('UPDATE pacts SET captured_cents = captured_cents + ? WHERE id = ?').run(award, pact.id);
      record({ pact_id: pact.id, milestone_id: m.id, type: 'CAPTURED', actor: 'paypal', amount_cents: award, paypal_ref: captureId });
    }
    const fee = feeFor(award, config.feeBps);
    const payout = await paypal.payout({
      batchId: `pact-${m.id}`, cents: award - fee, currency: pact.currency, receiver: pact.worker_email,
      note: `${pact.title}: ${m.title}`, itemId: m.id,
    });
    const payoutId = payout.batch_header.payout_batch_id;
    transition(m.id, ['RELEASING', 'PAYOUT_FAILED'], 'RELEASED', { payout_id: payoutId });
    record({ pact_id: pact.id, milestone_id: m.id, type: 'PAID_OUT', actor: 'paypal', amount_cents: award - fee, paypal_ref: payoutId, detail: `To ${pact.worker_email}` });
    if (fee) record({ pact_id: pact.id, milestone_id: m.id, type: 'PLATFORM_FEE', actor: 'system', amount_cents: fee, detail: `${config.feeBps / 100}%` });
  } catch (err) {
    const stage = captureId ? 'PAYOUT_FAILED' : 'CAPTURE_FAILED';
    record({ pact_id: pact.id, milestone_id: m.id, type: stage, actor: 'paypal', amount_cents: award, detail: (err as Error).message.slice(0, 240) });
    // A failed capture moved nothing, so the case returns for a person. A failed payout keeps
    // the capture and can be retried safely.
    db.prepare('UPDATE milestones SET status = ? WHERE id = ?').run(captureId ? 'PAYOUT_FAILED' : 'HELD', m.id);
    if (err instanceof PayPalError) throw new Conflict(err.message);
    throw err;
  }
  await closeIfDone(pact.id);
}

export const retryPayout = async (milestoneId: string) => {
  const m = getMilestone(milestoneId);
  if (m.status !== 'PAYOUT_FAILED') throw new Conflict('There is no failed payout to retry');
  await executeMoney(m.id, 'system', 'Retry after a failed payout');
};

/** When every milestone is decided, the unearned balance of the hold goes back to the buyer. */
async function closeIfDone(pactId: string) {
  const pact = getPact(pactId)!;
  if (pact.status !== 'ACTIVE') return;
  if (!milestonesOf(pactId).every((m) => TERMINAL.includes(m.status))) return;
  const remaining = pact.total_cents - pact.captured_cents;
  if (remaining > 0) {
    await paypal.void(pact.auth_id!, `void-${pact.id}`);
    record({ pact_id: pactId, type: 'HOLD_RELEASED', actor: 'paypal', amount_cents: remaining, paypal_ref: pact.auth_id, detail: 'Unearned balance returned. It was never charged.' });
  }
  setPact(pactId, { status: 'SETTLED' });
  record({ pact_id: pactId, type: 'PACT_SETTLED', actor: 'system', amount_cents: pact.captured_cents, detail: `Paid ${toValue(pact.captured_cents)} of ${toValue(pact.total_cents)}` });
}

/** Buyer decides. They may always choose to pay, including over a failed or held review. */
export const approve = (milestoneId: string) => {
  const m = getMilestone(milestoneId);
  return settle(m.id, m.amount_cents, 'buyer', 'Buyer approved the work', ['PASSED', 'FAILED', 'HELD', 'ESCALATED']);
};

export async function forfeit(milestoneId: string, actor: Role) {
  const m = getMilestone(milestoneId);
  if (actor === 'buyer' && !(m.due_at && now() > m.due_at)) throw new Conflict('A buyer can only cancel a milestone after its due date');
  await settle(m.id, 0, actor, actor === 'worker' ? 'Worker withdrew from this milestone' : 'Buyer cancelled an overdue milestone', ['OPEN', 'FAILED', 'HELD', 'ESCALATED']);
}

// ---- Disputes --------------------------------------------------------------

export function contest(milestoneId: string, by: Role, statement: string) {
  const m = getMilestone(milestoneId);
  const pact = getPact(m.pact_id)!;
  if (!pact.ai_arbitration) throw new Conflict('This pact does not use AI arbitration');
  const allowed: MilestoneStatus[] = by === 'buyer' ? ['PASSED', 'HELD'] : ['FAILED', 'HELD'];
  transition(m.id, allowed, 'CONTESTED', {
    contest_by: by, contest_statement: statement, release_at: null,
    convene_at: now() + pact.challenge_seconds * 1000,
  });
  record({ pact_id: pact.id, milestone_id: m.id, type: 'DISPUTE_OPENED', actor: by, amount_cents: m.amount_cents, detail: statement.slice(0, 200) });
}

export async function respond(milestoneId: string, by: Role, statement: string) {
  const m = getMilestone(milestoneId);
  if (m.status !== 'CONTESTED') throw new Conflict('There is no open dispute on this milestone');
  if (m.contest_by === by) throw new Conflict('Only the other party can respond');
  db.prepare('UPDATE milestones SET response_statement = ? WHERE id = ?').run(statement, m.id);
  record({ pact_id: m.pact_id, milestone_id: m.id, type: 'DISPUTE_RESPONSE', actor: by, detail: statement.slice(0, 200) });
  await convene(m.id);
}

export async function convene(milestoneId: string) {
  transition(milestoneId, ['CONTESTED'], 'IN_TRIBUNAL');
  const m = getMilestone(milestoneId);
  const pact = getPact(m.pact_id)!;
  const verification = verificationsOf(m.id).at(-1) ?? null;
  record({ pact_id: pact.id, milestone_id: m.id, type: 'TRIBUNAL_CONVENED', actor: 'system', amount_cents: m.amount_cents });

  let ruling;
  try {
    ruling = await holdTribunal({ pact, milestone: m, verification }, (s) => {
      db.prepare('INSERT INTO tribunal_steps VALUES (?,?,?,?,?,?,?,?)').run(s.id, s.milestone_id, s.seq, s.speaker, s.round, s.text, s.model, s.created_at);
      record({ pact_id: pact.id, milestone_id: m.id, type: 'TRIBUNAL_STEP', actor: s.speaker, detail: s.round });
    });
  } catch (err) {
    transition(m.id, ['IN_TRIBUNAL'], 'ESCALATED');
    record({ pact_id: pact.id, milestone_id: m.id, type: 'ESCALATED', actor: 'system', detail: `Tribunal could not finish: ${(err as Error).message.slice(0, 160)}` });
    return;
  }

  if (ruling.confidence < MIN_JUDGE_CONFIDENCE) {
    transition(m.id, ['IN_TRIBUNAL'], 'ESCALATED');
    record({ pact_id: pact.id, milestone_id: m.id, type: 'ESCALATED', actor: `ai:${modelName()}`, detail: `Judge confidence ${ruling.confidence} is below ${MIN_JUDGE_CONFIDENCE}. A person must decide.` });
    return;
  }
  const award = pctOf(m.amount_cents, ruling.award_pct);
  record({ pact_id: pact.id, milestone_id: m.id, type: 'VERDICT', actor: `ai:${modelName()}`, amount_cents: award, detail: `${ruling.award_pct}% to worker. ${ruling.ruling}`.slice(0, 400) });
  await settle(m.id, award, 'tribunal', `Tribunal awarded ${ruling.award_pct}%`, ['IN_TRIBUNAL']);
}

// ---- Restart recovery ------------------------------------------------------

/**
 * Work in flight when the process died has no owner, so it would sit forever. A review goes to
 * a person, a hearing starts over, and a settlement becomes a retry, which idempotent request
 * ids make safe even if the capture already went through.
 */
export function recoverInterrupted() {
  const stuck = db.prepare(`SELECT id, pact_id, status FROM milestones WHERE status IN ('VERIFYING', 'IN_TRIBUNAL', 'RELEASING')`)
    .all() as unknown as { id: string; pact_id: string; status: MilestoneStatus }[];
  for (const m of stuck) {
    if (m.status === 'VERIFYING') transition(m.id, ['VERIFYING'], 'HELD');
    if (m.status === 'RELEASING') transition(m.id, ['RELEASING'], 'PAYOUT_FAILED');
    if (m.status === 'IN_TRIBUNAL') {
      db.prepare('DELETE FROM tribunal_steps WHERE milestone_id = ?').run(m.id);
      transition(m.id, ['IN_TRIBUNAL'], 'CONTESTED', { convene_at: now() });
    }
    record({ pact_id: m.pact_id, milestone_id: m.id, type: 'RECOVERED', actor: 'system', detail: `Restarted while ${m.status}` });
  }
}

// ---- Time-based work -------------------------------------------------------

/** Runs on a timer. Each item is isolated so one bad pact cannot stall the rest. */
export async function sweep() {
  const at = now();
  const due = (db.prepare(`SELECT m.id, m.status, m.amount_cents, m.release_at, m.convene_at, p.auto_release_max_cents
    FROM milestones m JOIN pacts p ON p.id = m.pact_id
    WHERE p.status = 'ACTIVE' AND m.status IN ('PASSED', 'CONTESTED')`).all()) as unknown as
    { id: string; status: string; amount_cents: number; release_at: number | null; convene_at: number | null; auto_release_max_cents: number }[];

  for (const m of due) {
    try {
      if (m.status === 'PASSED' && m.release_at && at >= m.release_at && m.amount_cents <= m.auto_release_max_cents) {
        await settle(m.id, m.amount_cents, 'system', 'Verified, and the challenge window closed with no dispute', ['PASSED']);
      } else if (m.status === 'CONTESTED' && m.convene_at && at >= m.convene_at) {
        await convene(m.id);
      }
    } catch (err) {
      console.error('sweep', m.id, (err as Error).message);
    }
  }

  // Past PayPal's honor period a capture is less certain, so renew the hold on what is left.
  const stale = (db.prepare(`SELECT * FROM pacts WHERE status = 'ACTIVE' AND honor_expires_at < ?`).all(at)) as unknown as Pact[];
  for (const pact of stale) {
    const remaining = pact.total_cents - pact.captured_cents;
    try {
      const next = await paypal.reauthorize(pact.auth_id!, remaining, pact.currency, `reauth-${pact.auth_id}`);
      setPact(pact.id, { auth_id: next.id, honor_expires_at: at + HONOR_DAYS * DAY });
      record({ pact_id: pact.id, type: 'HOLD_RENEWED', actor: 'system', amount_cents: remaining, paypal_ref: next.id });
    } catch (err) {
      // Pushed out a day so a refusal does not repeat on every tick.
      setPact(pact.id, { honor_expires_at: at + DAY });
      record({ pact_id: pact.id, type: 'HOLD_RENEWAL_FAILED', actor: 'paypal', amount_cents: remaining, detail: (err as Error).message.slice(0, 200) });
    }
  }
}
