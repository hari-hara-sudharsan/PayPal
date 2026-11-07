import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { go, useMeta, usePath, type Meta } from './lib';
import { Home } from './Home';
import { NewPact } from './NewPact';
import { PactRoom } from './PactRoom';
import { Ledger } from './Ledger';
import { Agents } from './Agents';

export const Mark = () => (
  <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="9" fill="#1d5fd6" />
    <path d="M10 23V9h7.5a5 5 0 0 1 0 10H10" fill="none" stroke="#fff" strokeWidth="3" />
  </svg>
);

const Icon = ({ d }: { d: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

const NAV = [
  { to: '/', label: 'Pacts', icon: 'M3 2.5h7l3 3v8H3zM10 2.5v3h3M5.5 8.5h5M5.5 11h5' },
  { to: '/new', label: 'New pact', icon: 'M8 3v10M3 8h10' },
  { to: '/ledger', label: 'Ledger', icon: 'M2.5 3.5h11M2.5 8h11M2.5 12.5h11' },
  { to: '/agents', label: 'For agents', icon: 'M5 6 2.5 8 5 10M11 6l2.5 2L11 10M9 4.5l-2 7' },
];

const link = (to: string) => (e: React.MouseEvent) => { e.preventDefault(); go(to); };

function Shell({ path, meta, children }: { path: string; meta: Meta | null; children: React.ReactNode }) {
  const here = path.split('?')[0];
  return (
    <div className="shell">
      <aside className="side">
        <a className="brand" href="/" onClick={link('/')}><Mark /> Pact</a>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <a key={n.to} href={n.to} onClick={link(n.to)} className={here === n.to ? 'on' : ''} aria-current={here === n.to ? 'page' : undefined}>
              <Icon d={n.icon} /> {n.label}
            </a>
          ))}
        </nav>
        {meta && (
          <div className="side-foot">
            <div>PayPal<strong>{meta.paypal_mode === 'sandbox' ? 'Live sandbox' : 'Simulated (no real PayPal)'}</strong></div>
            <div>AI reviewer<strong>{meta.ai_provider === 'offline' ? 'Offline rules (no AI)' : meta.ai_model}</strong></div>
          </div>
        )}
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

/** Stands in for paypal.com when an agent's approval link is opened on the emulator. */
function SimCheckout({ orderId }: { orderId: string }) {
  const pact = new URLSearchParams(location.search).get('pact');
  const approve = async () => {
    await fetch(`/sim-paypal/sim/approve/${orderId}`, { method: 'POST' });
    location.href = `/api/paypal/return?pact=${pact}&token=${orderId}`;
  };
  return (
    <section className="card stack" style={{ maxWidth: 520, gap: 12 }}>
      <h1 style={{ fontSize: 24, fontWeight: 600 }}>Approve this hold</h1>
      <p className="mode-sim">Simulated approval page. On real PayPal, the buyer logs in and approves here.</p>
      <button className="btn primary" onClick={approve}>Approve the hold</button>
    </section>
  );
}

function App() {
  const path = usePath();
  const meta = useMeta();
  const here = path.split('?')[0]!;
  const pactId = here.match(/^\/p\/([^/]+)/)?.[1];
  const simOrder = here.match(/^\/sim-checkout\/([^/]+)/)?.[1];
  return (
    <Shell path={path} meta={meta}>
      {simOrder ? <SimCheckout orderId={simOrder} />
        : pactId ? <PactRoom key={pactId} id={pactId} meta={meta} />
        : here === '/new' ? <NewPact />
        : here === '/ledger' ? <Ledger />
        : here === '/agents' ? <Agents />
        : <Home />}
    </Shell>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
