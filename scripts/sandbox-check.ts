/**
 * Runs Pact's real PayPal client against the real PayPal sandbox, with no browser.
 * It funds the order with PayPal's published test card, which skips buyer approval so every
 * money operation can be exercised from a script. The buyer-approval path is tested by hand.
 *   npx tsx scripts/sandbox-check.ts
 */
import crypto from 'node:crypto';
import { config } from '../server/config';
import { authorizationOf, paypal, PayPalError } from '../server/paypal/client';

if (config.paypal.mode !== 'sandbox' || !config.paypal.base.includes('sandbox')) {
  console.error('Refusing to run: PayPal sandbox credentials are not configured.');
  process.exit(1);
}

const run = crypto.randomBytes(4).toString('hex');
let failed = 0;

async function step<T>(name: string, fn: () => Promise<T>, show: (r: T) => string = () => ''): Promise<T | undefined> {
  try {
    const result = await fn();
    console.log(`ok   ${name} ${show(result)}`);
    return result;
  } catch (err) {
    failed++;
    const detail = err instanceof PayPalError ? `${err.status} ${JSON.stringify(err.body).slice(0, 420)}` : (err as Error).message;
    console.log(`FAIL ${name}: ${detail}`);
    return undefined;
  }
}

async function token() {
  const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.secret}`).toString('base64');
  const res = await fetch(`${config.paypal.base}/v1/oauth2/token`, {
    method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials',
  });
  const body = await res.json() as { access_token?: string; scope?: string; app_id?: string; error_description?: string };
  if (!res.ok) throw new Error(`${res.status} ${body.error_description}`);
  return body;
}

/** Test card order: the only part that differs from what the app sends. */
async function cardOrder(cents: number) {
  const auth = await token();
  const res = await fetch(`${config.paypal.base}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', 'PayPal-Request-Id': `check-${run}-${cents}` },
    body: JSON.stringify({
      intent: 'AUTHORIZE',
      purchase_units: [{ reference_id: `check_${run}`, amount: { currency_code: 'USD', value: (cents / 100).toFixed(2) } }],
      payment_source: { card: { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Sandbox Tester' } },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new PayPalError(res.status, body, 'card order');
  return body;
}

const auth = await step('sandbox login', token, (t) => `(app ${t.app_id})`);
if (!auth) process.exit(1);
const scopes = auth.scope ?? '';
console.log(`     payouts scope: ${scopes.includes('payouts') ? 'present' : 'NOT in token'}`);

const appOrder = await step('create order exactly as the app does', () => paypal.createOrder({ pactId: `check_${run}`, description: 'Sandbox check', cents: 1000, currency: 'USD' }), (o) => `${o.status}, approval link ${o.links?.some((l) => l.rel === 'payer-action') ? 'present' : 'MISSING'}`);
void appOrder;

const order = await step('authorize a $100 hold with the test card', () => cardOrder(10_000), (o) => o.status);
const hold = order && authorizationOf(order);
console.log(`     authorization: ${hold ? `${hold.status}, expires ${hold.expiration_time}` : 'none'}`);

if (hold) {
  const cap = (cents: number, tag: string) => paypal.capture(hold.id, { cents, currency: 'USD', invoiceId: `check-${run}-${tag}`, note: 'Sandbox check', requestId: `cap-${run}-${tag}` });
  const first = await step('partial capture of $30', () => cap(3000, 'a'), (c) => `${c.status} ${c.id}`);
  await step('replay with the same request id', () => cap(3000, 'a'), (c) => (c.id === first?.id ? 'same capture returned, no double charge' : `DIFFERENT capture ${c.id}`));
  await step('second partial capture of $20', () => cap(2000, 'b'), (c) => `${c.status} ${c.id}`);
  await step('payout to a worker', () => paypal.payout({ batchId: `check-${run}`, cents: 2955, currency: 'USD', receiver: `worker-${run}@example.com`, note: 'Sandbox check', itemId: `check-${run}` }), (p) => `${p.batch_header.batch_status} ${p.batch_header.payout_batch_id}`);
  await step('void the unearned $50', () => paypal.void(hold.id, `void-${run}`), (v) => v.status ?? 'voided');
  await step('capture after void is refused', async () => {
    try { await cap(100, 'c'); } catch (err) { if (err instanceof PayPalError) return err.status; throw err; }
    throw new Error('PayPal accepted a capture on a voided authorization');
  }, (s) => `refused with ${s}`);
}

const renew = await step('authorize a second hold', () => cardOrder(5000), (o) => o.status);
const second = renew && authorizationOf(renew);
if (second) {
  await step('reauthorize inside the honor period', () => paypal.reauthorize(second.id, 5000, 'USD', `reauth-${run}`), (r) => `${r.status} ${r.id}`);
}

console.log(failed ? `\n${failed} FAILED` : '\nAll sandbox checks passed');
process.exit(failed ? 1 : 0);

export {};
