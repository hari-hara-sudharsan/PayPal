import { config } from './config';
import { db } from './db';
import { simApprove } from './paypal/sim';
import * as E from './engine/pacts';
import type { Draft } from './ai/draft';

const history: { draft: Draft; buyer: string; worker: string }[] = [
  {
    buyer: 'maya@northwind.example', worker: 'jonas@copy.example',
    draft: {
      title: 'Launch email sequence', summary: 'Three emails for a product launch.', currency: 'USD',
      buyer_name: 'Maya', worker_name: 'Jonas', clarifications: [], warnings: [],
      milestones: [
        { title: 'Welcome email', amount: 120, due_days: 3, criteria: [{ text: 'At least 10 words', kind: 'min_words', arg: 10 }] },
        { title: 'Follow-up email', amount: 180, due_days: 6, criteria: [{ text: 'Includes the offer code', kind: 'must_include', arg: 'LAUNCH20' }] },
      ],
    },
  },
  {
    buyer: 'priya@tealeaf.example', worker: 'sam@studio.example',
    draft: {
      title: 'Product photo retouching', summary: 'Retouching notes for twelve product shots.', currency: 'USD',
      buyer_name: 'Priya', worker_name: 'Sam', clarifications: [], warnings: [],
      milestones: [
        { title: 'Retouch batch one', amount: 90, due_days: 4, criteria: [{ text: 'At least 10 words', kind: 'min_words', arg: 10 }] },
      ],
    },
  },
];

async function seed() {
  if (config.paypal.mode !== 'sim') return;
  const row = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pacts');
  if (row && row.n > 0) return;

  for (const h of history) {
    const pact = await E.createPact({ draft: h.draft, buyer_email: h.buyer, worker_email: h.worker, source_text: 'Sample data', challenge_seconds: 3600 });
    await E.signPact((await E.getPact(pact.id))!);
    const { orderId } = await E.createFundingOrder((await E.getPact(pact.id))!);
    await simApprove(orderId);
    await E.completeFunding((await E.getPact(pact.id))!, orderId);
    await db.run('UPDATE milestones SET status = ? WHERE pact_id = ?', 'PASSED', pact.id);
    for (const m of await E.milestonesOf(pact.id)) await E.approve(m.id);
  }
}

let seeding: Promise<void> | null = null;

/** Gives the emulator's ledger some history. Real sandbox runs start empty. */
export const seedIfEmpty = () => (seeding ??= seed().catch((err) => { console.error('seed failed', err); }));
