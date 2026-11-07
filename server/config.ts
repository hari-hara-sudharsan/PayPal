import 'dotenv/config';

const env = process.env;
const port = Number(env.PORT ?? 8787);
const live = Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);

export const config = {
  port,
  dbPath: env.PACT_DB ?? 'data/pact.db',
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  feeBps: Number(env.PLATFORM_FEE_BPS ?? 150),
  mcpToken: env.MCP_TOKEN ?? '',
  publicLedger: env.PUBLIC_LEDGER !== '0',
  paypal: {
    mode: (live ? 'sandbox' : 'sim') as 'sandbox' | 'sim',
    clientId: env.PAYPAL_CLIENT_ID || 'sim-client',
    secret: env.PAYPAL_CLIENT_SECRET || 'sim-secret',
    webhookId: env.PAYPAL_WEBHOOK_ID ?? '',
    // The emulator is mounted on this same server; tests repoint this at a random port.
    base: live ? 'https://api-m.sandbox.paypal.com' : `http://127.0.0.1:${port}/sim-paypal`,
  },
  ai: {
    anthropicKey: env.ANTHROPIC_API_KEY ?? '',
    openaiKey: env.OPENAI_API_KEY ?? '',
    openaiBase: (env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: env.AI_MODEL ?? '',
    forceOffline: env.PACT_AI === 'offline',
  },
};
