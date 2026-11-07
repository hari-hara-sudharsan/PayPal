import 'dotenv/config';

const env = process.env;
const port = Number(env.PORT ?? 8787);
const live = Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
const vercelUrl = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '';

export const config = {
  port,
  dbPath: env.PACT_DB ?? 'data/pact.db',
  db: { url: env.TURSO_DATABASE_URL ?? '', token: env.TURSO_AUTH_TOKEN ?? '' },
  publicUrl: (env.PUBLIC_URL || vercelUrl || `http://localhost:${port}`).replace(/\/$/, ''),
  feeBps: Number(env.PLATFORM_FEE_BPS ?? 150),
  mcpToken: env.MCP_TOKEN ?? '',
  cronSecret: env.CRON_SECRET ?? '',
  publicLedger: env.PUBLIC_LEDGER !== '0',
  limits: {
    perVisitorHour: Number(env.AI_LIMIT_PER_VISITOR_HOUR ?? 40),
    modelCallsPerDay: Number(env.AI_LIMIT_PER_DAY ?? 400),
  },
  paypal: {
    mode: (live ? 'sandbox' : 'sim') as 'sandbox' | 'sim',
    clientId: env.PAYPAL_CLIENT_ID || 'sim-client',
    secret: env.PAYPAL_CLIENT_SECRET || 'sim-secret',
    webhookId: env.PAYPAL_WEBHOOK_ID ?? '',
    base: live ? 'https://api-m.sandbox.paypal.com' : 'sim://paypal',
  },
  /** Public test logins for judges. Sandbox accounts hold no real money. */
  sandbox: {
    buyerEmail: env.SANDBOX_BUYER_EMAIL ?? '',
    buyerPassword: env.SANDBOX_BUYER_PASSWORD ?? '',
    workerEmail: env.SANDBOX_WORKER_EMAIL ?? '',
  },
  ai: {
    anthropicKey: env.ANTHROPIC_API_KEY ?? '',
    openaiKey: env.OPENAI_API_KEY ?? '',
    openaiBase: (env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: env.AI_MODEL ?? '',
    forceOffline: env.PACT_AI === 'offline',
  },
};
