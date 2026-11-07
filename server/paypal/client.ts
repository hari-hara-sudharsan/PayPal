import { config } from '../config';
import { toValue } from '../money';
import { simFetch } from './sim';

const send = (url: string, init: RequestInit) =>
  (config.paypal.mode === 'sim' ? simFetch(url, init) : fetch(url, init));

export class PayPalError extends Error {
  constructor(public status: number, public body: unknown, public op: string) {
    super(`PayPal ${op} failed (${status}): ${JSON.stringify(body).slice(0, 300)}`);
  }
}

let token: { value: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.secret}`).toString('base64');
  const res = await send(`${config.paypal.base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const body = await res.json() as { access_token: string; expires_in: number };
  if (!res.ok) throw new PayPalError(res.status, body, 'oauth');
  token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return token.value;
}

async function call<T>(op: string, method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
  const res = await send(`${config.paypal.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      // A stable id per money movement makes every retry safe: PayPal replays, it does not re-charge.
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) throw new PayPalError(res.status, parsed, op);
  return parsed as T;
}

interface Link { href: string; rel: string }
interface Order {
  id: string; status: string; links?: Link[];
  purchase_units?: { payments?: { authorizations?: { id: string; status: string; expiration_time?: string }[] } }[];
}

export const paypal = {
  /** Holds the buyer's funds without taking them. Nothing leaves their account until a capture. */
  createOrder: (p: { pactId: string; description: string; cents: number; currency: string }) =>
    call<Order>('create order', 'POST', '/v2/checkout/orders', {
      intent: 'AUTHORIZE',
      purchase_units: [{
        reference_id: p.pactId, custom_id: p.pactId, description: p.description.slice(0, 127),
        amount: { currency_code: p.currency, value: toValue(p.cents) },
      }],
      payment_source: { paypal: { experience_context: {
        brand_name: 'Pact', shipping_preference: 'NO_SHIPPING', user_action: 'CONTINUE',
        return_url: `${config.publicUrl}/api/paypal/return?pact=${p.pactId}`,
        cancel_url: `${config.publicUrl}/p/${p.pactId}`,
      } } },
    }, `order-${p.pactId}`),

  authorizeOrder: (orderId: string) =>
    call<Order>('authorize order', 'POST', `/v2/checkout/orders/${orderId}/authorize`, {}, `authz-${orderId}`),

  capture: (authId: string, p: { cents: number; currency: string; invoiceId: string; note: string; requestId: string }) =>
    call<{ id: string; status: string }>('capture', 'POST', `/v2/payments/authorizations/${authId}/capture`, {
      amount: { currency_code: p.currency, value: toValue(p.cents) },
      invoice_id: p.invoiceId, note_to_payer: p.note.slice(0, 255), final_capture: false,
    }, p.requestId),

  void: (authId: string, requestId: string) =>
    call<{ status?: string }>('void', 'POST', `/v2/payments/authorizations/${authId}/void`, undefined, requestId),

  reauthorize: (authId: string, cents: number, currency: string, requestId: string) =>
    call<{ id: string; status: string; expiration_time?: string }>('reauthorize', 'POST', `/v2/payments/authorizations/${authId}/reauthorize`, {
      amount: { currency_code: currency, value: toValue(cents) },
    }, requestId),

  payout: (p: { batchId: string; cents: number; currency: string; receiver: string; note: string; itemId: string }) =>
    call<{ batch_header: { payout_batch_id: string; batch_status: string } }>('payout', 'POST', '/v1/payments/payouts', {
      sender_batch_header: { sender_batch_id: p.batchId, email_subject: 'You have been paid through Pact', email_message: p.note.slice(0, 1000) },
      items: [{
        recipient_type: 'EMAIL', amount: { value: toValue(p.cents), currency: p.currency },
        receiver: p.receiver, note: p.note.slice(0, 1000), sender_item_id: p.itemId.slice(0, 63),
      }],
    }, p.batchId),

  /** A batch is accepted first and settles later, so acceptance alone does not mean paid. */
  payoutStatus: (batchId: string) =>
    call<{ batch_header: { batch_status: string }; items?: { transaction_status?: string; errors?: { name?: string; message?: string } }[] }>(
      'payout status', 'GET', `/v1/payments/payouts/${batchId}`),

  verifyWebhook: (p: { headers: Record<string, string | string[] | undefined>; event: unknown }) =>
    call<{ verification_status: string }>('verify webhook', 'POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: p.headers['paypal-auth-algo'], cert_url: p.headers['paypal-cert-url'],
      transmission_id: p.headers['paypal-transmission-id'], transmission_sig: p.headers['paypal-transmission-sig'],
      transmission_time: p.headers['paypal-transmission-time'], webhook_id: config.paypal.webhookId, webhook_event: p.event,
    }),
};

export const authorizationOf = (o: Order) => o.purchase_units?.[0]?.payments?.authorizations?.[0];
export const approvalLink = (o: Order) => o.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
