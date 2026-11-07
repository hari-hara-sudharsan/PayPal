/**
 * Emits Vercel's Build Output API. Bundling the server ourselves avoids two problems with
 * zero-config detection: ESM extensionless imports fail at runtime, and rewrites would have to
 * guess the function's path. See https://vercel.com/docs/build-output-api
 */
import { build } from 'esbuild';
import fs from 'node:fs';

const out = '.vercel/output';
const fn = `${out}/functions/server.func`;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(fn, { recursive: true });
fs.cpSync('dist', `${out}/static`, { recursive: true });

await build({
  entryPoints: ['server/vercel.ts'], outfile: `${fn}/index.js`, bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning',
  // Only reached by the local driver, which never runs on Vercel.
  external: ['node:sqlite'],
  footer: { js: 'module.exports = module.exports.default || module.exports;' },
});

fs.writeFileSync(`${fn}/package.json`, JSON.stringify({ type: 'commonjs' }));
fs.writeFileSync(`${fn}/.vc-config.json`, JSON.stringify({
  runtime: 'nodejs22.x', handler: 'index.js', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 300,
}));

fs.writeFileSync(`${out}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    { src: '^/(api|mcp|sim-paypal|healthz)(/.*)?$', dest: '/server' },
    { handle: 'filesystem' },
    { src: '/.*', dest: '/index.html' },
  ],
  crons: [{ path: '/api/cron/sweep', schedule: '0 6 * * *' }],
}, null, 2));

console.log('Build output written to', out);
