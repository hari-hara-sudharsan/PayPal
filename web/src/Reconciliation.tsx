import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { go, money } from './lib';
import { HoldBar } from './HoldBar';
import { gridTheme, type LedgerEntry } from './Ledger';

interface Book {
  pact_id: string; title: string; currency: string; held: number; captured: number; paid: number;
  fee: number; returned: number; open: number; owed: number; chain: boolean;
}

/** One row per pact, built from ledger events, so any money that fails to add up is visible. */
function buildBooks(rows: LedgerEntry[], chains: Record<string, boolean>): Book[] {
  const books = new Map<string, Book>();
  for (const r of rows) {
    const b = books.get(r.pact_id) ?? {
      pact_id: r.pact_id, title: r.pact_title, currency: r.currency, held: 0, captured: 0, paid: 0,
      fee: 0, returned: 0, open: 0, owed: 0, chain: chains[r.pact_id] !== false,
    };
    const cents = r.amount_cents ?? 0;
    if (r.type === 'FUNDS_HELD') b.held += cents;
    if (r.type === 'HOLD_RENEWED') continue;
    if (r.type === 'CAPTURED') b.captured += cents;
    if (r.type === 'PAID_OUT') b.paid += cents;
    if (r.type === 'PLATFORM_FEE') b.fee += cents;
    if (r.type === 'HOLD_RELEASED') b.returned += cents;
    books.set(r.pact_id, b);
  }
  return [...books.values()]
    .filter((b) => b.held > 0)
    .map((b) => ({ ...b, open: b.held - b.captured - b.returned, owed: b.captured - b.paid - b.fee }));
}

// The grid treats a changed prop as new configuration, so these must keep one identity.
const DEFAULT_COL: ColDef<Book> = { sortable: true, resizable: true };
const rowId = (p: { data: Book }) => p.data.pact_id || 'total';

const cents = (key: keyof Book, header: string, width = 118): ColDef<Book> => ({
  headerName: header, field: key, width, type: 'rightAligned', filter: 'agNumberColumnFilter',
  cellClass: ['ag-right-aligned-cell', 'num'], valueFormatter: (p) => money(Number(p.value ?? 0), p.data?.currency),
});

export function Reconciliation({ rows, chains }: { rows: LedgerEntry[]; chains: Record<string, boolean> }) {
  const books = useMemo(() => buildBooks(rows, chains), [rows, chains]);

  const totals = useMemo<Book[]>(() => [books.reduce<Book>((t, b) => ({
    ...t, held: t.held + b.held, captured: t.captured + b.captured, paid: t.paid + b.paid, fee: t.fee + b.fee,
    returned: t.returned + b.returned, open: t.open + b.open, owed: t.owed + b.owed, chain: t.chain && b.chain,
  }), { pact_id: '', title: `All ${books.length} pacts`, currency: 'USD', held: 0, captured: 0, paid: 0, fee: 0, returned: 0, open: 0, owed: 0, chain: true })], [books]);

  const columns = useMemo<ColDef<Book>[]>(() => [
    {
      headerName: 'Pact', field: 'title', flex: 1, minWidth: 190, filter: true,
      cellRenderer: (p: { value: string; data: Book }) => (p.data.pact_id
        ? <a href={`/p/${p.data.pact_id}`} onClick={(e) => { e.preventDefault(); go(`/p/${p.data.pact_id}`); }}>{p.value}</a>
        : <strong>{p.value}</strong>),
    },
    {
      headerName: 'Where the money is', field: 'held', width: 190, sortable: false,
      cellRenderer: (p: { data: Book }) => (
        <div className="cell-bar"><HoldBar slim paid={p.data.captured} held={p.data.open} back={p.data.returned} /></div>
      ),
    },
    cents('held', 'Held'), cents('captured', 'Captured'), cents('paid', 'Paid out'), cents('fee', 'Fees', 96),
    cents('returned', 'Never charged', 124), cents('open', 'Still held'),
    {
      headerName: 'Books', field: 'owed', width: 120,
      cellRenderer: (p: { data: Book }) => {
        if (!p.data.chain) return <span className="pill negative">Tampered</span>;
        return p.data.owed === 0
          ? <span className="pill positive">Balanced</span>
          : <span className="pill warning">{money(p.data.owed, p.data.currency)} owed</span>;
      },
    },
  ], []);

  return (
    <>
      <p className="small muted" style={{ padding: '14px 24px 0' }}>
        Every cent held must end up paid, charged as a fee, or never charged. A row only reads Balanced when captures equal payouts plus fees.
      </p>
      <div style={{ height: 500, marginTop: 8 }}>
        <AgGridReact<Book>
          theme={gridTheme} rowData={books} columnDefs={columns} pinnedBottomRowData={totals}
          defaultColDef={DEFAULT_COL} getRowId={rowId} animateRows
        />
      </div>
    </>
  );
}
