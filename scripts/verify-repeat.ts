/**
 * Runs the real AI reviewer on the demo's sample deliverables several times, to measure how
 * reliably the configured model answers. Uses the model in .env and counts against its limits.
 *   npx tsx scripts/verify-repeat.ts [runs]
 */
import { verifyDeliverable } from '../server/ai/verify';
import { modelName } from '../server/ai/llm';
import type { Milestone } from '../server/types';

const runs = Number(process.argv[2] ?? 3);
const milestone = {
  id: 'ms_check', pact_id: 'p', idx: 0, title: 'Homepage copy', amount_cents: 15000, due_at: null, status: 'OPEN',
  criteria: [
    { id: 'c1.1', text: 'At least 100 words', kind: 'min_words', arg: 100 },
    { id: 'c1.2', text: 'Mentions the 4am bake', kind: 'must_include', arg: '4am bake' },
    { id: 'c1.3', text: 'Mentions the Saturday market', kind: 'must_include', arg: 'Saturday market' },
    { id: 'c1.4', text: 'Explains how the bread is made, naming at least two ingredients or steps', kind: 'judgment', arg: null },
  ],
} as unknown as Milestone;

const samples = (await import('../web/src/samples')).SAMPLE_WORK;
console.log(`model: ${modelName()}`);
for (const sample of samples) {
  const tally: Record<string, number> = {};
  for (let i = 0; i < runs; i++) {
    const started = Date.now();
    const v = await verifyDeliverable(milestone, i + 1, sample.text, null);
    const key = v.summary.includes('unavailable') ? `HOLD (AI failed: ${v.summary.split('(')[1]?.slice(0, 50)})` : v.outcome;
    tally[key] = (tally[key] ?? 0) + 1;
    console.log(`  ${sample.name.padEnd(26)} ${v.outcome.padEnd(5)} ${((Date.now() - started) / 1000).toFixed(1)}s  ${v.summary.slice(0, 70)}`);
  }
  console.log(`${sample.name}: ${JSON.stringify(tally)}`);
}
