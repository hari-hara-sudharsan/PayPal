import crypto from 'node:crypto';
import { Router } from 'express';
import { db } from '../db';
import { config } from '../config';
import { now } from '../clock';
import { toCents } from '../money';

/**
 * Local emulator of the PayPal REST endpoints Pact uses, so the app runs with zero credentials.
 * The real client in client.ts talks to it through a fetch-shaped function, and it enforces the
 * rules that matter: capture limits, idempotent replays, no void after full capture.
 * It never touches PayPal, and its state lives in the app database so it survives serverless.
 */
const get = async <T>(k: string) => {
  const row = await db.get<{ v: string }>('SELECT v FROM sim_kv WHERE k = ?', k);
  return row ? JSON.parse(row.v) as T : undefined;
};
const put = (k: string, v: unknown) =>
  db.run('INSERT INTO sim_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v));

interface SimOrder { id: string; status: string; cents: number; currency: string; authId?: string }
interface SimAuth { id: string; orderId: string; cents: number; captured: number; currency: string; status: string; createdAt: number }
type Out = { status: number; body: unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

const DAY = 86_400_000;
const id = (p: string) => `${p}${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
const fail = (issue: string): Out => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue }], message: issue } });
const missing: Out = { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } };

async function createOrder(_: string, body: Body): Promise<Out> {
  const pu = body.purchase_units[0];
  const order: SimOrder = { id: id('SIMORD'), status: 'CREATED', cents: toCents(pu.amount.value), currency: pu.amount.currency_code };
  await put(`order:${order.id}`, order);
  return { status: 201, body: { id: order.id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `${config.publicUrl}/sim-checkout/${order.id}?pact=${pu.reference_id}` }] } };
}

async function authorizeOrder(orderId: string): Promise<Out> {
  const order = await get<SimOrder>(`order:${orderId}`);
  if (!order) return missing;
  if (order.status !== 'APPROVED') return fail('ORDER_NOT_APPROVED');
  const auth: SimAuth = { id: id('SIMAUTH'), orderId: order.id, cents: order.cents, captured: 0, currency: order.currency, status: 'CREATED', createdAt: now() };
  await put(`auth:${auth.id}`, auth);
  await put(`order:${order.id}`, { ...order, status: 'COMPLETED', authId: auth.id });
  return { status: 201, body: { id: order.id, status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{
    id: auth.id, status: 'CREATED', expiration_time: new Date(auth.createdAt + 29 * DAY).toISOString(),
  }] } }] } };
}

async function capture(authId: string, body: Body): Promise<Out> {
  const auth = await get<SimAuth>(`auth:${authId}`);
  if (!auth) return missing;
  if (auth.status === 'VOIDED') return fail('AUTHORIZATION_VOIDED');
  if (now() > auth.createdAt + 29 * DAY) return fail('AUTHORIZATION_EXPIRED');
  const cents = toCents(body.amount.value);
  if (auth.captured + cents > auth.cents) return fail('MAX_CAPTURE_AMOUNT_EXCEEDED');
  const captured = auth.captured + cents;
  await put(`auth:${auth.id}`, { ...auth, captured, status: captured === auth.cents ? 'CAPTURED' : 'PARTIALLY_CAPTURED' });
  return { status: 201, body: { id: id('SIMCAP'), status: 'COMPLETED', amount: body.amount, final_capture: !!body.final_capture } };
}

async function voidAuth(authId: string): Promise<Out> {
  const auth = await get<SimAuth>(`auth:${authId}`);
  if (!auth) return missing;
  if (auth.status === 'CAPTURED') return fail('PREVIOUSLY_CAPTURED');
  await put(`auth:${auth.id}`, { ...auth, status: 'VOIDED' });
  return { status: 200, body: { id: auth.id, status: 'VOIDED' } };
}

async function reauthorize(authId: string, body: Body): Promise<Out> {
  const auth = await get<SimAuth>(`auth:${authId}`);
  if (!auth) return missing;
  if (auth.status === 'VOIDED') return fail('AUTHORIZATION_VOIDED');
  const next: SimAuth = { ...auth, id: id('SIMAUTH'), cents: toCents(body.amount.value), captured: 0, status: 'CREATED' };
  await put(`auth:${next.id}`, next);
  await put(`auth:${auth.id}`, { ...auth, status: 'VOIDED' });
  return { status: 201, body: { id: next.id, status: 'CREATED', expiration_time: new Date(auth.createdAt + 29 * DAY).toISOString() } };
}

async function payout(_: string, body: Body): Promise<Out> {
  if (String(body.items[0].receiver).includes('fail-payout')) return fail('RECEIVER_UNREGISTERED');
  return { status: 201, body: { batch_header: { payout_batch_id: id('SIMPAY'), batch_status: 'PENDING' } } };
}

const ROUTES: [RegExp, (param: string, body: Body) => Promise<Out>][] = [
  [/^\/v2\/checkout\/orders$/, createOrder],
  [/^\/v2\/checkout\/orders\/([^/]+)\/authorize$/, authorizeOrder],
  [/^\/v2\/payments\/authorizations\/([^/]+)\/capture$/, capture],
  [/^\/v2\/payments\/authorizations\/([^/]+)\/void$/, voidAuth],
  [/^\/v2\/payments\/authorizations\/([^/]+)\/reauthorize$/, reauthorize],
  [/^\/v1\/payments\/payouts$/, payout],
];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** Same shape as fetch, so the PayPal client runs one code path against the emulator and PayPal. */
export async function simFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const path = url.replace(config.paypal.base, '');
  if (path === '/v1/oauth2/token') return json(200, { access_token: id('SIMTOKEN'), expires_in: 32400 });

  for (const [pattern, handler] of ROUTES) {
    const match = path.match(pattern);
    if (!match) continue;
    // Same contract as PayPal: repeat a PayPal-Request-Id and you get the first response back.
    const key = new Headers(init.headers).get('PayPal-Request-Id');
    const seen = key ? await get<Out>(`idem:${key}`) : undefined;
    if (seen) return json(seen.status, seen.body);
    const out = await handler(match[1] ?? '', init.body ? JSON.parse(String(init.body)) : {});
    if (key && out.status < 400) await put(`idem:${key}`, out);
    return json(out.status, out.body);
  }
  return json(404, missing.body);
}

/** Stands in for the buyer logging in and approving on paypal.com. */
export async function simApprove(orderId: string): Promise<boolean> {
  const order = await get<SimOrder>(`order:${orderId}`);
  if (!order) return false;
  await put(`order:${order.id}`, { ...order, status: 'APPROVED' });
  return true;
}

export function simRouter() {
  const r = Router();
  r.post('/sim/approve/:id', async (req, res) => {
    const found = await simApprove(req.params.id);
    res.status(found ? 200 : 404).json({ status: found ? 'APPROVED' : 'RESOURCE_NOT_FOUND' });
  });
  return r;
}
