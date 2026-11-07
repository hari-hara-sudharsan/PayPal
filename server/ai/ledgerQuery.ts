import { z } from 'zod';
import { ask } from './llm';

const FilterSchema = z.object({
  types: z.array(z.string()),
  min_amount: z.number().nullable(),
  max_amount: z.number().nullable(),
  text: z.string().nullable(),
  explanation: z.string(),
});
export type LedgerFilter = z.infer<typeof FilterSchema>;

const SYSTEM = (types: string[]) => `Translate a plain-English question about a payments ledger into a filter.
Row types: ${types.join(', ')}.
- types: the row types that answer the question, or an empty list for all.
- min_amount, max_amount: dollars, or null.
- text: a word to match in the pact name or detail, or null.
- explanation: one short sentence saying what the filter shows.
Plain meanings: money paid to workers is PAID_OUT; money taken from buyers is CAPTURED; AI rulings are VERDICT; attacks are SHIELD_ALERT; money returned to buyers is HOLD_RELEASED.`;

function offline(q: string, types: string[]): LedgerFilter {
  const lower = q.toLowerCase();
  const hits = types.filter((t) => t.toLowerCase().split('_').some((w) => w.length > 3 && lower.includes(w)));
  const min = lower.match(/(?:over|above|more than)\s*\$?(\d+)/)?.[1];
  return {
    types: hits, min_amount: min ? Number(min) : null, max_amount: null, text: null,
    explanation: 'Offline keyword filter.',
  };
}

export const translateLedgerQuery = async (q: string, types: string[]): Promise<LedgerFilter> => {
  const filter = await ask(FilterSchema, SYSTEM(types), `<question>${q}</question>`, () => offline(q, types));
  // The result drives a UI filter only, and unknown row types are dropped.
  return { ...filter, types: filter.types.filter((t) => types.includes(t)) };
};
