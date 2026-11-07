import { config } from './config';
import { db } from './db';
import * as E from './engine/pacts';
import type { Draft } from './ai/draft';

const history: { draft: Draft; buyer: string; worker: string; award?: 'contest' }[] = [
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

/** Gives the emulator's ledger history on first boot. Real sandbox runs start empty. */
export async function seedIfEmpty() {
  if (config.paypal.mode !== 'sim') return;
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM pacts').get() as { n: number };
  if (n > 0) return;

  for (const h of history) {
    const pact = E.createPact({ draft: h.draft, buyer_email: h.buyer, worker_email: h.worker, source_text: 'Sample data', challenge_seconds: 3600 });
    E.signPact(E.getPact(pact.id)!);
    const { orderId } = await E.createFundingOrder(E.getPact(pact.id)!);
    await fetch(`${config.paypal.base}/sim/approve/${orderId}`, { method: 'POST' });
    await E.completeFunding(E.getPact(pact.id)!, orderId);
    db.prepare('UPDATE milestones SET status = ? WHERE pact_id = ?').run('PASSED', pact.id);
    for (const m of E.milestonesOf(pact.id)) await E.approve(m.id);
  }
}
