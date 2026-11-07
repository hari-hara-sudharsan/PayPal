import crypto from 'node:crypto';
import { db } from './db';
import { now } from './clock';

export interface LedgerRow {
  seq: number; pact_id: string; milestone_id: string | null; type: string; actor: string;
  amount_cents: number | null; paypal_ref: string | null; detail: string; at: number;
  prev_hash: string; hash: string;
}

const GENESIS = '0'.repeat(64);
const MAX_APPEND_ATTEMPTS = 8;

const digest = (r: Omit<LedgerRow, 'seq' | 'hash'>) =>
  crypto.createHash('sha256').update(JSON.stringify([
    r.prev_hash, r.pact_id, r.milestone_id, r.type, r.actor, r.amount_cents, r.paypal_ref, r.detail, r.at,
  ])).digest('hex');

export const ledgerFor = (pactId: string) =>
  db.all<LedgerRow>('SELECT * FROM ledger WHERE pact_id = ? ORDER BY seq', pactId);

/**
 * Append-only and hash-chained per pact: altering any row breaks every hash after it.
 * Two writers can read the same tip, so UNIQUE (pact_id, prev_hash) lets exactly one of them
 * extend it. The loser rereads the tip and tries again, which keeps the chain a single line.
 */
export async function record(e: {
  pact_id: string; milestone_id?: string | null; type: string; actor: string;
  amount_cents?: number | null; paypal_ref?: string | null; detail?: string;
}): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const last = await db.get<{ hash: string }>('SELECT hash FROM ledger WHERE pact_id = ? ORDER BY seq DESC LIMIT 1', e.pact_id);
    const row = {
      pact_id: e.pact_id, milestone_id: e.milestone_id ?? null, type: e.type, actor: e.actor,
      amount_cents: e.amount_cents ?? null, paypal_ref: e.paypal_ref ?? null, detail: e.detail ?? '',
      at: now(), prev_hash: last?.hash ?? GENESIS,
    };
    try {
      await db.run(
        'INSERT INTO ledger (pact_id, milestone_id, type, actor, amount_cents, paypal_ref, detail, at, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
        row.pact_id, row.milestone_id, row.type, row.actor, row.amount_cents, row.paypal_ref, row.detail, row.at, row.prev_hash, digest(row),
      );
      return;
    } catch (err) {
      if (!/UNIQUE/i.test(String(err)) || attempt >= MAX_APPEND_ATTEMPTS) throw err;
    }
  }
}

export async function verifyChain(pactId: string): Promise<{ intact: boolean; length: number; brokenAt: number | null }> {
  const rows = await ledgerFor(pactId);
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || digest(r) !== r.hash) return { intact: false, length: rows.length, brokenAt: r.seq };
    prev = r.hash;
  }
  return { intact: true, length: rows.length, brokenAt: null };
}
