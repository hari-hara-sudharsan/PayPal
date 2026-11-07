/** Runs one real dispute through a running server and prints the hearing. Leaves the pact for viewing. */
const BASE = process.env.PACT_URL ?? 'http://localhost:8787';

const call = async (path: string, key?: string, body?: unknown) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-pact-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(data)}`);
  return data;
};

const agreement = `Lena: We need the bakery homepage copy, $150, and 3 sourdough blog posts for $250. Homepage must mention the 4am bake and the Saturday market. Should feel warm and modern.
Tomas: Deal. Homepage in 5 days, posts a week later. Blog posts at least 300 words each.`;

let t = Date.now();
const draft = await call('/drafts', undefined, { text: agreement });
console.log(`draft ${(Date.now() - t) / 1000}s:`, JSON.stringify(draft, null, 1).slice(0, 1500));

const pact = await call('/pacts', undefined, { draft, buyer_email: 'lena@example.com', worker_email: 'tomas@example.com', source_text: agreement, challenge_seconds: 3600 });
const buyer = new URL(pact.buyer_link, BASE).searchParams.get('k')!;
const worker = new URL(pact.worker_link, BASE).searchParams.get('k')!;
await call(`/pacts/${pact.id}/sign`, worker, {});
const { orderId } = await call(`/pacts/${pact.id}/order`, buyer, {});
await fetch(`${BASE}/sim-paypal/sim/approve/${orderId}`, { method: 'POST' });
await call(`/pacts/${pact.id}/authorize`, buyer, { orderId });

const ms = (await call(`/pacts/${pact.id}`, buyer)).milestones[0];
const text = `Rye & Salt bakes before the city wakes. Our ovens are lit for the 4am bake every day and our loaves are warm by sunrise. We use local flour and sea salt. Find us at the Saturday market. Our bakery has served this neighbourhood with love, and we think you will taste the difference in every crust and crumb of every loaf we shape by hand for you and your family.`;
const v = await call(`/pacts/${pact.id}/milestones/${ms.id}/submit`, worker, { text });
console.log('review:', v.outcome, v.summary);

const by = v.outcome === 'PASS' ? 'buyer' : 'worker';
await call(`/pacts/${pact.id}/milestones/${ms.id}/contest`, by === 'buyer' ? buyer : worker, {
  statement: by === 'buyer' ? 'It reads like a template and is much shorter than I expected.' : 'The review was too strict. The copy does what we agreed.',
});
t = Date.now();
await call(`/pacts/${pact.id}/milestones/${ms.id}/respond`, by === 'buyer' ? worker : buyer, {
  statement: by === 'buyer' ? 'The contract lists the requirements and the copy meets them.' : 'It feels thin compared with what we discussed.',
});

for (;;) {
  await new Promise((r) => setTimeout(r, 3000));
  const m = (await call(`/pacts/${pact.id}`, buyer)).milestones[0];
  if (!['IN_TRIBUNAL', 'CONTESTED', 'RELEASING'].includes(m.status)) {
    console.log(`\nhearing ${(Date.now() - t) / 1000}s -> ${m.status}, awarded ${m.awarded_cents}`);
    for (const s of m.tribunal) console.log(`\n[${s.speaker} / ${s.round}]\n${s.text}`);
    break;
  }
}
console.log(`\nbuyer view: /p/${pact.id}?k=${buyer}\nworker view: /p/${pact.id}?k=${worker}`);

export {};
