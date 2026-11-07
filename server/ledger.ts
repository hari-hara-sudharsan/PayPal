import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { db } from './db';
import { now } from './clock';

export interface LedgerRow {
  seq: number; pact_id: string; milestone_id: string | null; type: string; actor: string;
  amount_cents: number | null; paypal_ref: string | null; detail: string; at: number;
  prev_hash: string; hash: string;
}

/** Fires on every ledger write; the SSE stream relays it to open pages. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

const GENESIS = '0'.repeat(64);

const digest = (r: Omit<LedgerRow, 'seq' | 'hash'>) =>
  crypto.createHash('sha256').update(JSON.stringify([
    r.prev_hash, r.pact_id, r.milestone_id, r.type, r.actor, r.amount_cents, r.paypal_ref, r.detail, r.at,
  ])).digest('hex');

export const ledgerFor = (pactId: string) =>
  db.prepare('SELECT * FROM ledger WHERE pact_id = ? ORDER BY seq').all(pactId) as unknown as LedgerRow[];

/** Append-only and hash-chained per pact: altering any row breaks every hash after it. */
export function record(e: {
  pact_id: string; milestone_id?: string | null; type: string; actor: string;
  amount_cents?: number | null; paypal_ref?: string | null; detail?: string;
}): LedgerRow {
  const last = db.prepare('SELECT hash FROM ledger WHERE pact_id = ? ORDER BY seq DESC LIMIT 1')
    .get(e.pact_id) as { hash: string } | undefined;
  const row = {
    pact_id: e.pact_id, milestone_id: e.milestone_id ?? null, type: e.type, actor: e.actor,
    amount_cents: e.amount_cents ?? null, paypal_ref: e.paypal_ref ?? null, detail: e.detail ?? '',
    at: now(), prev_hash: last?.hash ?? GENESIS,
  };
  const hash = digest(row);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO ledger (pact_id, milestone_id, type, actor, amount_cents, paypal_ref, detail, at, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(row.pact_id, row.milestone_id, row.type, row.actor, row.amount_cents, row.paypal_ref, row.detail, row.at, row.prev_hash, hash);
  const saved = { ...row, seq: Number(lastInsertRowid), hash };
  bus.emit('event', saved);
  return saved;
}

export function verifyChain(pactId: string): { intact: boolean; length: number; brokenAt: number | null } {
  const rows = ledgerFor(pactId);
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || digest(r) !== r.hash) return { intact: false, length: rows.length, brokenAt: r.seq };
    prev = r.hash;
  }
  return { intact: true, length: rows.length, brokenAt: null };
}
