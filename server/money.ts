/** All money is integer cents internally. Floats only exist at the AI and PayPal string boundaries. */
export const toCents = (dollars: number | string): number => {
  const n = typeof dollars === 'string' ? Number(dollars) : dollars;
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid amount: ${dollars}`);
  return Math.round(n * 100);
};

export const toValue = (cents: number): string => (cents / 100).toFixed(2);

export const feeFor = (cents: number, bps: number): number => Math.round((cents * bps) / 10_000);

/** Share of a whole in cents, floored so an award can never round up past its milestone. */
export const pctOf = (cents: number, pct: number): number =>
  Math.floor((cents * Math.min(100, Math.max(0, pct))) / 100);
