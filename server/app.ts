import express from 'express';
import { config } from './config';
import { apiRouter } from './api';
import { mcpRouter } from './mcp';
import { simRouter } from './paypal/sim';

/** The HTTP app, shared by the self-hosted server and the Vercel function. */
export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.get('/healthz', (_q, s) => { s.json({ ok: true }); });
  app.use('/api', apiRouter());
  app.use('/mcp', mcpRouter());
  if (config.paypal.mode === 'sim') app.use('/sim-paypal', simRouter());
  return app;
}
