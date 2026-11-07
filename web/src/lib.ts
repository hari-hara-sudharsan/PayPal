import { useEffect, useState } from 'react';
import type { Milestone, Pact, Role, TribunalStep, Verification } from '../../server/types';
import type { LedgerRow } from '../../server/ledger';

export interface MilestoneView extends Milestone { verifications: Verification[]; tribunal: TribunalStep[] }
export interface PactView extends Omit<Pact, 'buyer_key' | 'worker_key'> {
  role: Role | null; milestones: MilestoneView[]; ledger: LedgerRow[];
  chain: { intact: boolean; length: number; brokenAt: number | null };
  links?: { worker: string };
}
export interface Meta { paypal_mode: 'sim' | 'sandbox'; paypal_client_id: string | null; ai_provider: string; ai_model: string; fee_bps: number }

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; pactKey?: string } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(opts.pactKey ? { 'x-pact-key': opts.pactKey } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export const money = (cents: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

/** Keys for pacts created in this browser, so one person can demo both sides. */
const store = {
  read(): Record<string, { buyer?: string; worker?: string }> {
    try { return JSON.parse(localStorage.getItem('pact-keys') ?? '{}'); } catch { return {}; }
  },
  save(id: string, role: Role, key: string) {
    try {
      const all = store.read();
      localStorage.setItem('pact-keys', JSON.stringify({ ...all, [id]: { ...all[id], [role]: key } }));
    } catch { /* Private mode: the key in the URL still works. */ }
  },
};
export const keys = store;

export function useMeta() {
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => { api<Meta>('/meta').then(setMeta).catch(() => {}); }, []);
  return meta;
}

export const go = (to: string) => {
  history.pushState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
};

export function usePath() {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const on = () => setPath(location.pathname + location.search);
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  return path;
}

export const STATUS: Record<string, { label: string; tone: string }> = {
  OPEN: { label: 'Waiting on work', tone: 'neutral' },
  VERIFYING: { label: 'Under review', tone: 'accent' },
  PASSED: { label: 'Verified', tone: 'positive' },
  FAILED: { label: 'Not met', tone: 'negative' },
  HELD: { label: 'Held for a person', tone: 'warning' },
  CONTESTED: { label: 'In dispute', tone: 'warning' },
  IN_TRIBUNAL: { label: 'Tribunal in session', tone: 'accent' },
  ESCALATED: { label: 'Needs a person', tone: 'warning' },
  RELEASING: { label: 'Paying out', tone: 'accent' },
  RELEASED: { label: 'Paid', tone: 'positive' },
  PAYOUT_FAILED: { label: 'Payout failed', tone: 'negative' },
  FORFEITED: { label: 'Not paid', tone: 'neutral' },
  AWAITING_SIGNATURE: { label: 'Waiting on signature', tone: 'neutral' },
  AWAITING_FUNDS: { label: 'Waiting on funds', tone: 'warning' },
  ACTIVE: { label: 'Funds held', tone: 'accent' },
  SETTLED: { label: 'Settled', tone: 'positive' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export const LEDGER_LABEL: Record<string, string> = {
  PACT_CREATED: 'Pact created', PACT_SIGNED: 'Worker signed', ORDER_CREATED: 'PayPal order created',
  FUNDS_HELD: 'Funds held', WORK_SUBMITTED: 'Work submitted', VERIFIED_PASS: 'Verified', VERIFIED_FAIL: 'Not met',
  VERIFIED_HOLD: 'Held for a person', SHIELD_ALERT: 'Shield alert', CAPTURE_INTENT: 'Capture approved',
  CAPTURED: 'Captured', PAID_OUT: 'Paid to worker', PLATFORM_FEE: 'Platform fee', NOT_AWARDED: 'Not awarded',
  HOLD_RELEASED: 'Hold released', PACT_SETTLED: 'Settled', DISPUTE_OPENED: 'Dispute opened',
  DISPUTE_RESPONSE: 'Response filed', TRIBUNAL_CONVENED: 'Tribunal convened', TRIBUNAL_STEP: 'Tribunal turn',
  VERDICT: 'Verdict', ESCALATED: 'Sent to a person', HOLD_RENEWED: 'Hold renewed', HOLD_RENEWAL_FAILED: 'Renewal failed',
  RECOVERED: 'Recovered after restart', CAPTURE_FAILED: 'Capture failed', PAYOUT_FAILED: 'Payout failed', WEBHOOK: 'PayPal webhook',
};
