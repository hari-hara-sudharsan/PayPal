import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config';
import { createApp } from './app';
import { sweep } from './engine/pacts';
import { modelName, provider } from './ai/llm';

const app = createApp();

const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api|\/mcp|\/sim-paypal).*/, (_q, s) => s.sendFile(path.join(dist, 'index.html')));
}

// Express 5 reports a failed bind through this callback. Without the check, a second instance
// would log success and run a second sweeper against the same database.
app.listen(config.port, (err?: Error) => {
  if (err) {
    console.error(`Could not start: ${err.message}`);
    process.exit(1);
  }
  console.log(`Pact on ${config.publicUrl} | PayPal: ${config.paypal.mode} | AI: ${provider()} (${modelName()})`);
  setInterval(() => sweep().catch((e) => console.error('sweep', e)), 5000);
});
