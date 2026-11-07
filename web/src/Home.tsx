import { useEffect, useState } from 'react';
import { api, go, keys, money, STATUS } from './lib';
import { HoldBar } from './HoldBar';

interface Row { id: string; title: string; status: string; total_cents: number; captured_cents: number; currency: string; created_at: number }

const pactHref = (id: string) => {
  const k = keys.read()[id];
  const key = k?.buyer ?? k?.worker;
  return key ? `/p/${id}?k=${key}` : `/p/${id}`;
};

export function Home() {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => { api<Row[]>('/pacts').then(setRows).catch(() => setRows([])); }, []);

  return (
    <div className="stack">
      <div className="head">
        <div>
          <h1>Money that moves when the work is proven</h1>
          <p>Turn a chat into a contract. The buyer's money waits in a PayPal hold, and is paid out only when the work is verified against what was agreed.</p>
        </div>
        <button className="btn primary" onClick={() => go('/new')}>Start a pact</button>
      </div>

      <div className="card steps">
        <div><h3>Agree</h3><p className="small muted">Paste the conversation. AI writes milestones with acceptance criteria anyone could check.</p></div>
        <div><h3>Hold</h3><p className="small muted">Funds are authorized at PayPal. Nothing is charged, and the worker can see the money is real.</p></div>
        <div><h3>Prove</h3><p className="small muted">Work is reviewed against the contract. Disputes go to a tribunal whose verdict executes as PayPal calls.</p></div>
      </div>

      <section className="card" aria-label="Pacts">
        <h2>Pacts</h2>
        {rows === null && <p className="muted small">Loading…</p>}
        {rows?.length === 0 && <p className="muted small" style={{ marginTop: 8 }}>No pacts yet. Start one from any conversation.</p>}
        <div style={{ marginTop: 8 }}>
          {rows?.map((p) => {
            const settled = p.status === 'SETTLED';
            const paid = p.captured_cents;
            return (
              <a key={p.id} className="pact-row" href={pactHref(p.id)} onClick={(e) => { e.preventDefault(); go(pactHref(p.id)); }}>
                <div>
                  <h3>{p.title}</h3>
                  <span className={`pill ${STATUS[p.status]?.tone}`}>{STATUS[p.status]?.label}</span>
                </div>
                <HoldBar slim paid={paid} held={settled ? 0 : p.total_cents - paid} back={settled ? p.total_cents - paid : 0} />
                <div className="num" style={{ textAlign: 'right', fontWeight: 600 }}>{money(p.total_cents, p.currency)}</div>
              </a>
            );
          })}
        </div>
      </section>
    </div>
  );
}
