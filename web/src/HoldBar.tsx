/** The product's signature: every cent of the buyer's money, as paid, still held, or never charged. */
export function HoldBar({ paid, held, back, slim }: { paid: number; held: number; back: number; slim?: boolean }) {
  return (
    <div
      className={`hold${slim ? ' slim' : ''}`}
      role="img"
      aria-label={`${(paid / 100).toFixed(2)} paid, ${(held / 100).toFixed(2)} held, ${(back / 100).toFixed(2)} returned`}
    >
      {paid > 0 && <i className="paid" style={{ flexGrow: paid }} />}
      {held > 0 && <i className="held" style={{ flexGrow: held }} />}
      {back > 0 && <i className="back" style={{ flexGrow: back }} />}
    </div>
  );
}
