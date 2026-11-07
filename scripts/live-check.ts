/**
 * Checks what only fails on real serverless infrastructure. Run against a deployment:
 *   PACT_URL=https://your-app.vercel.app npx tsx scripts/live-check.ts
 */
const BASE = process.env.PACT_URL ?? 'http://localhost:8787';

async function call(path: string, key?: string, body?: unknown) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-pact-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(data)}`);
  return data;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const draft = {
  title: 'Live check', summary: 'Automated deployment check.', currency: 'USD',
  buyer_name: 'Ana', worker_name: 'Ben', clarifications: [], warnings: [],
  milestones: [{ title: 'Note', amount: 40, due_days: 2, criteria: [{ text: 'At least 5 words', kind: 'min_words', arg: 5 }] }],
};

async function funded() {
  const pact = await call('/pacts', undefined, { draft, buyer_email: 'ana@example.org', worker_email: 'ben@example.org', source_text: 'live check', challenge_seconds: 10 });
  const buyer = new URL(pact.buyer_link, BASE).searchParams.get('k')!;
  const worker = new URL(pact.worker_link, BASE).searchParams.get('k')!;
  await call(`/pacts/${pact.id}/sign`, worker, {});
  const { orderId } = await call(`/pacts/${pact.id}/order`, buyer, {});
  const approved = await fetch(`${BASE}/sim-paypal/sim/approve/${orderId}`, { method: 'POST' });
  if (!approved.ok) throw new Error(`approve ${approved.status}`);
  await call(`/pacts/${pact.id}/authorize`, buyer, { orderId });
  const ms = (await call(`/pacts/${pact.id}`, buyer)).milestones[0];
  return { id: pact.id as string, buyer, worker, ms: ms.id as string };
}

async function waitFor(id: string, key: string, done: (m: any) => boolean, seconds: number) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const view = await call(`/pacts/${id}`, key);
    if (done(view.milestones[0])) return view;
    if (Date.now() > end) throw new Error(`Timed out with status ${view.milestones[0].status}`);
    await pause(2000);
  }
}

let failed = 0;
async function check(name: string, run: () => Promise<string>) {
  const start = Date.now();
  try {
    console.log(`ok   ${name}: ${await run()} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
}

await check('state survives across requests', async () => {
  const p = await funded();
  for (let i = 0; i < 8; i++) {
    const view = await call(`/pacts/${p.id}`, p.buyer);
    if (view.status !== 'ACTIVE') throw new Error(`Read ${i} saw ${view.status}`);
  }
  return '8 reads consistent';
});

await check('release with no server process', async () => {
  const p = await funded();
  await call(`/pacts/${p.id}/milestones/${p.ms}/submit`, p.worker, { text: 'one two three four five six seven' });
  const view = await waitFor(p.id, p.buyer, (m) => m.status === 'RELEASED', 40);
  if (view.captured_cents !== 4000) throw new Error(`captured ${view.captured_cents}`);
  return `paid ${view.captured_cents} cents after the window`;
});

await check('concurrent release pays once', async () => {
  const p = await funded();
  await call(`/pacts/${p.id}/milestones/${p.ms}/submit`, p.worker, { text: 'one two three four five six seven' });
  const tries = await Promise.allSettled(Array.from({ length: 5 }, () => call(`/pacts/${p.id}/milestones/${p.ms}/approve`, p.buyer, {})));
  await pause(1500);
  const view = await call(`/pacts/${p.id}`, p.buyer);
  const captures = view.ledger.filter((r: any) => r.type === 'CAPTURED').length;
  if (captures !== 1 || view.captured_cents !== 4000) throw new Error(`${captures} captures, ${view.captured_cents} cents`);
  if (!view.chain.intact) throw new Error('chain broken');
  return `${tries.filter((t) => t.status === 'fulfilled').length} of 5 accepted, 1 capture, chain intact`;
});

await check('tribunal outlives its request', async () => {
  const p = await funded();
  await call(`/pacts/${p.id}/milestones/${p.ms}/submit`, p.worker, { text: 'one two three four five six seven' });
  await call(`/pacts/${p.id}/milestones/${p.ms}/contest`, p.buyer, { statement: 'This is too thin to be useful.' });
  await call(`/pacts/${p.id}/milestones/${p.ms}/respond`, p.worker, { statement: 'The contract only asked for five words.' });
  const view = await waitFor(p.id, p.buyer, (m) => !['CONTESTED', 'IN_TRIBUNAL', 'RELEASING'].includes(m.status), 150);
  const m = view.milestones[0];
  if (m.tribunal.length !== 5) throw new Error(`${m.tribunal.length} steps, status ${m.status}`);
  return `${m.status}, awarded ${m.awarded_cents} of 4000`;
});

await check('access control', async () => {
  const p = await funded();
  const denied = await fetch(`${BASE}/api/pacts/${p.id}/milestones/${p.ms}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pact-key': p.worker }, body: '{}' });
  const anon = await fetch(`${BASE}/api/pacts/${p.id}/milestones/${p.ms}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const view = await (await fetch(`${BASE}/api/pacts/${p.id}`)).json();
  if (denied.status !== 403 || anon.status !== 403) throw new Error(`worker ${denied.status}, anonymous ${anon.status}`);
  if (String(view.worker_email).includes('ben@') || 'buyer_key' in view) throw new Error('private data exposed to anonymous viewer');
  return 'worker and anonymous blocked, private fields hidden';
});

await check('cron rejects strangers', async () => {
  const res = await fetch(`${BASE}/api/cron/sweep`);
  if (res.status !== 403) throw new Error(`status ${res.status}`);
  return 'blocked';
});

console.log(failed ? `\n${failed} FAILED` : '\nAll live checks passed');
process.exit(failed ? 1 : 0);

export {};
