import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GridApi, type IRowNode } from 'ag-grid-community';
import { api, go, LEDGER_LABEL, money } from './lib';
import { Reconciliation } from './Reconciliation';

ModuleRegistry.registerModules([AllCommunityModule]);

export const gridTheme = themeQuartz.withParams({
  fontFamily: 'Manrope, Inter, system-ui, sans-serif', fontSize: 14, headerFontSize: 12, headerFontWeight: 500,
  headerTextColor: '#5c6064', headerBackgroundColor: '#ffffff', backgroundColor: '#ffffff', foregroundColor: '#1b1d1f',
  borderColor: '#f0f1f2', rowBorder: { color: '#f0f1f2' }, wrapperBorder: false, wrapperBorderRadius: 0,
  rowHoverColor: '#f2f8fd', accentColor: '#1d5fd6', columnBorder: false, rowHeight: 44, headerHeight: 40,
});

export interface LedgerEntry {
  seq: number; pact_id: string; pact_title: string; currency: string; type: string; actor: string;
  amount_cents: number | null; paypal_ref: string | null; detail: string; at: number; hash: string;
}
interface Filter { types: string[]; min_amount: number | null; max_amount: number | null; text: string | null; explanation: string }

const TONE: Record<string, string> = {
  PAID_OUT: 'positive', CAPTURED: 'accent', FUNDS_HELD: 'accent', VERDICT: 'accent', SHIELD_ALERT: 'negative',
  VERIFIED_FAIL: 'negative', VERIFIED_HOLD: 'warning', VERIFIED_PASS: 'positive', DISPUTE_OPENED: 'warning', HOLD_RELEASED: 'neutral', PAYOUT_CONFIRMED: 'positive', PAYOUT_REVERSED: 'negative', PAYOUT_UNCLAIMED: 'warning', PAYOUT_OWED: 'warning',
};
const ACTOR: Record<string, string> = { advocate_worker: 'Worker advocate', advocate_buyer: 'Buyer advocate', judge: 'Arbiter', paypal: 'PayPal', shield: 'Shield' };

// The grid treats a changed prop as new configuration, so these must keep one identity.
const DEFAULT_COL: ColDef<LedgerEntry> = { sortable: true, resizable: true };
const rowId = (p: { data: LedgerEntry }) => String(p.data.seq);

const QUESTIONS = ['What did workers get paid over $100?', 'Show every attack the shield caught', 'Which rulings did the AI make?'];

export function Ledger() {
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [chains, setChains] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [visible, setVisible] = useState({ captured: 0, paid: 0, count: 0 });
  const [view, setView] = useState<'events' | 'books'>('events');
  const grid = useRef<GridApi<LedgerEntry> | null>(null);
  const filterRef = useRef<Filter | null>(null);

  useEffect(() => {
    api<{ rows: LedgerEntry[]; chains: Record<string, boolean> }>('/ledger').then((d) => { setRows(d.rows); setChains(d.chains); }).catch((e) => setError(e.message));
  }, []);

  const tally = useCallback(() => {
    const out = { captured: 0, paid: 0, count: 0 };
    grid.current?.forEachNodeAfterFilter((n) => {
      out.count++;
      if (n.data?.type === 'CAPTURED') out.captured += n.data.amount_cents ?? 0;
      if (n.data?.type === 'PAID_OUT') out.paid += n.data.amount_cents ?? 0;
    });
    // Same values must keep the same object: a new one re-renders, which updates the grid again.
    setVisible((prev) => (prev.captured === out.captured && prev.paid === out.paid && prev.count === out.count ? prev : out));
  }, []);

  const filterActive = useCallback(() => filterRef.current !== null, []);

  const applyFilter = (f: Filter | null) => {
    filterRef.current = f;
    setFilter(f);
    grid.current?.onFilterChanged();
  };

  const ask = async (question: string) => {
    setQ(question); setBusy(true); setError('');
    try { applyFilter(await api<Filter>('/ledger/ask', { body: { q: question } })); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const columns = useMemo<ColDef<LedgerEntry>[]>(() => [
    { headerName: 'When', field: 'at', width: 150, valueFormatter: (p) => new Date(p.value).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) },
    {
      headerName: 'Event', field: 'type', width: 180, filter: true,
      cellRenderer: (p: { value: string }) => <span className={`pill ${TONE[p.value] ?? 'neutral'}`}>{LEDGER_LABEL[p.value] ?? p.value}</span>,
    },
    {
      headerName: 'Pact', field: 'pact_title', flex: 1, minWidth: 170, filter: true,
      cellRenderer: (p: { value: string; data: LedgerEntry }) => (
        <a href={`/p/${p.data.pact_id}`} onClick={(e) => { e.preventDefault(); go(`/p/${p.data.pact_id}`); }}>{p.value}</a>
      ),
    },
    { headerName: 'By', field: 'actor', width: 150, filter: true, valueFormatter: (p) => ACTOR[p.value] ?? String(p.value).replace(/^ai:.*/, 'AI') },
    {
      headerName: 'Amount', field: 'amount_cents', width: 120, type: 'rightAligned', filter: 'agNumberColumnFilter',
      valueFormatter: (p) => (p.value == null ? '–' : money(p.value, p.data?.currency)), cellClass: ['ag-right-aligned-cell', 'num'],
    },
    { headerName: 'PayPal reference', field: 'paypal_ref', width: 190, cellClass: 'grid-ref', valueFormatter: (p) => p.value ?? '–' },
    { headerName: 'Detail', field: 'detail', flex: 1.4, minWidth: 220, tooltipField: 'detail' },
    {
      headerName: 'Chain', field: 'hash', width: 110, sortable: false,
      cellRenderer: (p: { value: string; data: LedgerEntry }) => (
        <span title={p.value} className={`pill ${chains[p.data.pact_id] === false ? 'negative' : 'positive'}`}>{chains[p.data.pact_id] === false ? 'Broken' : p.value.slice(0, 6)}</span>
      ),
    },
  ], [chains]);

  const passes = useCallback((node: IRowNode<LedgerEntry>) => {
    const f = filterRef.current;
    const r = node.data;
    if (!f || !r) return true;
    if (f.types.length && !f.types.includes(r.type)) return false;
    const dollars = (r.amount_cents ?? 0) / 100;
    if (f.min_amount != null && dollars < f.min_amount) return false;
    if (f.max_amount != null && dollars > f.max_amount) return false;
    if (f.text && !`${r.pact_title} ${r.detail}`.toLowerCase().includes(f.text.toLowerCase())) return false;
    return true;
  }, []);

  return (
    <div className="stack">
      <div className="head">
        <div>
          <h1>Ledger</h1>
          <p>Every movement of money and every AI decision, in one tamper-evident record.</p>
        </div>
        <button className="btn" onClick={() => grid.current?.exportDataAsCsv({ fileName: 'pact-ledger.csv' })}>Export CSV</button>
      </div>

      <section className="card stack" style={{ gap: 12 }}>
        <form className="ask" onSubmit={(e) => { e.preventDefault(); if (q.trim()) ask(q); }}>
          <input className="plain" aria-label="Ask the ledger" placeholder="Ask the ledger in plain English" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn primary" disabled={busy}>{busy ? 'Asking…' : 'Ask'}</button>
        </form>
        <div className="row small">
          {QUESTIONS.map((x) => <button key={x} className="btn sm" onClick={() => ask(x)}>{x}</button>)}
          {filter && <button className="btn sm" onClick={() => { applyFilter(null); setQ(''); }}>Clear</button>}
        </div>
        {filter && <p className="small muted">{filter.explanation}</p>}
        {error && <div className="notice bad" style={{ marginTop: 0 }}>{error}</div>}
      </section>

      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="row between" style={{ padding: '16px 24px 0' }}>
          <div className="seg" role="group" aria-label="Ledger view">
            <button className={view === 'events' ? 'on' : ''} onClick={() => setView('events')}>Every event</button>
            <button className={view === 'books' ? 'on' : ''} onClick={() => setView('books')}>Reconciliation</button>
          </div>
        </div>
        {view === 'books' && <Reconciliation rows={rows} chains={chains} />}
        <div style={{ display: view === 'events' ? 'block' : 'none' }}>
        <div className="row" style={{ padding: '16px 24px', gap: 40 }}>
          <div className="stat"><span>Captured from buyers</span><div className="money">{money(visible.captured)}</div></div>
          <div className="stat"><span>Paid to workers</span><div className="money">{money(visible.paid)}</div></div>
          <div className="stat"><span>Entries shown</span><div className="money">{visible.count}</div></div>
        </div>
        <div style={{ height: 560 }}>
          <AgGridReact<LedgerEntry>
            theme={gridTheme} rowData={rows} columnDefs={columns} defaultColDef={DEFAULT_COL}
            getRowId={rowId} animateRows tooltipShowDelay={300}
            onGridReady={(e) => { grid.current = e.api; }}
            isExternalFilterPresent={filterActive}
            doesExternalFilterPass={passes}
            onModelUpdated={tally}
          />
        </div>
        </div>
      </section>
    </div>
  );
}
