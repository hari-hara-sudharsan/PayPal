import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config';
import { apiRouter } from './api';
import { mcpRouter } from './mcp';
import { simRouter } from './paypal/sim';
import { recoverInterrupted, sweep } from './engine/pacts';
import { modelName, provider } from './ai/llm';
import { seedIfEmpty } from './seed';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.get('/healthz', (_q, s) => { s.json({ ok: true }); });
app.use('/api', apiRouter());
app.use('/mcp', mcpRouter());
if (config.paypal.mode === 'sim') app.use('/sim-paypal', simRouter());

const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api|\/mcp|\/sim-paypal).*/, (_q, s) => s.sendFile(path.join(dist, 'index.html')));
}

// Express 5 reports a failed bind through this callback. Without the check, a second instance
// would log success and run a second sweeper against the same database.
app.listen(config.port, async (err?: Error) => {
  if (err) {
    console.error(`Could not start: ${err.message}`);
    process.exit(1);
  }
  console.log(`Pact on ${config.publicUrl} | PayPal: ${config.paypal.mode} | AI: ${provider()} (${modelName()})`);
  recoverInterrupted();
  await seedIfEmpty().catch((err) => console.error('seed failed', err));
  setInterval(() => sweep().catch((err) => console.error('sweep', err)), 5000);
});
