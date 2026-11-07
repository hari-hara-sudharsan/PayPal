import { useCallback, useEffect, useRef, useState } from 'react';
import type { Role } from '../../server/types';
import { api, go, keys, LEDGER_LABEL, money, STATUS, type Meta, type MilestoneView, type PactView } from './lib';
import { HoldBar } from './HoldBar';
import { BUYER_COMPLAINT, SAMPLE_WORK, WORKER_REPLY } from './samples';

const useNow = () => {
  const [t, setT] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setT(Date.now()), 1000); return () => clearInterval(i); }, []);
  return t;
};

export function PactRoom({ id, meta }: { id: string; meta: Meta | null }) {
  const urlKey = new URLSearchParams(location.search).get('k') ?? '';
  const [key, setKey] = useState(urlKey);
  const [pact, setPact] = useState<PactView | null>(null);
  const [error, setError] = useState('');
  const known = keys.read()[id] ?? {};

  const load = useCallback(() => {
    api<PactView>(`/pacts/${id}`, { pactKey: key }).then((p) => {
      setPact(p);
      if (p.role && key) keys.save(id, p.role, key);
    }).catch((e) => setError(e.message));
  }, [id, key]);

  useEffect(load, [load]);

  // Polling also drives time-based release on serverless, so it runs fast only while something is due.
  const active = pact?.milestones.some((m) => ['VERIFYING', 'IN_TRIBUNAL', 'RELEASING', 'PASSED', 'CONTESTED'].includes(m.status));
  useEffect(() => {
    const timer = setInterval(load, active ? 2000 : 8000);
    return () => clearInterval(timer);
  }, [load, active]);

  const act = useCallback(async (path: string, body?: unknown) => {
    setError('');
    try {
      await api(`/pacts/${id}${path}`, { method: 'POST', body: body ?? {}, pactKey: key });
    } catch (e) { setError((e as Error).message); }
    load();
  }, [id, key, load]);

  if (!pact) return <p className="muted">{error || 'Loading…'}</p>;

  const paid = pact.captured_cents;
  const settled = pact.status === 'SETTLED';
  const held = settled ? 0 : pact.total_cents - paid;
  const back = settled ? pact.total_cents - paid : 0;
  const switchTo = (r: Role) => { if (known[r]) { setKey(known[r]!); go(`/p/${id}?k=${known[r]}`); } };

  return (
    <div className="stack">
      <div className="head">
        <div>
          <h1>{pact.title}</h1>
          <p>{pact.buyer_name} pays {pact.worker_name}. {pact.summary}</p>
        </div>
        {known.buyer && known.worker && (
          <div className="seg" role="group" aria-label="View as">
            <button className={pact.role === 'buyer' ? 'on' : ''} onClick={() => switchTo('buyer')}>{pact.buyer_name} (buyer)</button>
            <button className={pact.role === 'worker' ? 'on' : ''} onClick={() => switchTo('worker')}>{pact.worker_name} (worker)</button>
          </div>
        )}
      </div>

      {error && <div className="notice bad" style={{ marginTop: 0 }} role="alert">{error}</div>}

      <section className="card" aria-label="Where the money is">
        <div className="hold-figures">
          <div><span>Paid to {pact.worker_name}</span><div className="money">{money(paid, pact.currency)}</div></div>
          <div><span>Held at PayPal</span><div className="money">{money(pact.funded_at ? held : 0, pact.currency)}</div></div>
          <div><span>Returned to {pact.buyer_name}</span><div className="money">{money(back, pact.currency)}</div></div>
          <div style={{ marginLeft: 'auto', alignSelf: 'center' }}><span className={`pill ${STATUS[pact.status]?.tone}`}>{STATUS[pact.status]?.label}</span></div>
        </div>
        <HoldBar paid={paid} held={held} back={back} />
        <div className="key">
          <span><b style={{ background: 'var(--accent)' }} /> Paid</span>
          <span><b style={{ background: 'var(--accent-soft)' }} /> {pact.funded_at ? 'Held, not charged' : 'Not funded yet'}</span>
          <span><b style={{ background: '#cfd4da' }} /> Never charged</span>
          {pact.auth_expires_at && !settled && <span>Hold valid until {new Date(pact.auth_expires_at).toLocaleDateString()}</span>}
        </div>
      </section>

      <Gate pact={pact} meta={meta} act={act} pactKey={key} reload={load} />

      <div className="split">
        <div className="stack">
          {pact.milestones.map((m) => <MilestoneCard key={m.id} m={m} pact={pact} act={act} />)}
        </div>
        <Trail pact={pact} />
      </div>
    </div>
  );
}

function Gate({ pact, meta, act, pactKey, reload }: { pact: PactView; meta: Meta | null; act: (p: string, b?: unknown) => Promise<void>; pactKey: string; reload: () => void }) {
  if (pact.status === 'AWAITING_SIGNATURE') {
    return (
      <section className="card row between">
        <div>
          <h2>Waiting for {pact.worker_name} to sign</h2>
          <p className="small muted">Terms fingerprint {pact.terms_hash.slice(0, 16)}. Signing locks the milestones and criteria below.</p>
        </div>
        {pact.role === 'worker'
          ? <button className="btn primary" onClick={() => act('/sign')}>Sign the pact</button>
          : <ShareLink pact={pact} />}
      </section>
    );
  }
  if (pact.status === 'AWAITING_FUNDS') {
    return (
      <section className="card">
        <h2>Hold {money(pact.total_cents, pact.currency)} at PayPal</h2>
        <p className="small muted" style={{ marginBottom: 14 }}>This authorizes the money without charging it. Anything not earned is released back to {pact.buyer_name}.</p>
        {pact.role === 'buyer'
          ? <Funding pact={pact} meta={meta} pactKey={pactKey} reload={reload} />
          : <p className="small">Waiting for {pact.buyer_name} to fund this pact. Do not start work until the money is held.</p>}
      </section>
    );
  }
  return null;
}

function ShareLink({ pact }: { pact: PactView }) {
  const [copied, setCopied] = useState(false);
  if (!pact.links) return null;
  const url = location.origin + pact.links.worker;
  return (
    <button className="btn" onClick={() => navigator.clipboard.writeText(url).then(() => setCopied(true))}>
      {copied ? 'Link copied' : `Copy ${pact.worker_name}'s link`}
    </button>
  );
}

declare global { interface Window { paypal?: { Buttons: (o: unknown) => { render: (el: HTMLElement) => void } } } }

function Funding({ pact, meta, pactKey, reload }: { pact: PactView; meta: Meta | null; pactKey: string; reload: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!meta?.paypal_client_id || !box.current) return;
    const target = box.current;
    const mount = () => {
      target.innerHTML = '';
      window.paypal!.Buttons({
        style: { layout: 'horizontal', tagline: false, height: 44 },
        createOrder: async () => (await api<{ orderId: string }>(`/pacts/${pact.id}/order`, { method: 'POST', body: {}, pactKey })).orderId,
        onApprove: async (data: { orderID: string }) => {
          await api(`/pacts/${pact.id}/authorize`, { body: { orderId: data.orderID }, pactKey });
          reload();
        },
        onError: (e: Error) => setErr(e.message ?? 'PayPal could not complete this'),
      }).render(target);
    };
    if (window.paypal) return mount();
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${meta.paypal_client_id}&intent=authorize&currency=${pact.currency}`;
    s.onload = mount;
    document.head.appendChild(s);
  }, [meta?.paypal_client_id, pact.id, pact.currency, pactKey, reload]);

  const simulate = async () => {
    setErr('');
    try {
      const { orderId } = await api<{ orderId: string }>(`/pacts/${pact.id}/order`, { method: 'POST', body: {}, pactKey });
      await fetch(`/sim-paypal/sim/approve/${orderId}`, { method: 'POST' });
      await api(`/pacts/${pact.id}/authorize`, { body: { orderId }, pactKey });
      reload();
    } catch (e) { setErr((e as Error).message); }
  };

  if (meta?.paypal_mode === 'sandbox') return <><div ref={box} style={{ maxWidth: 360 }} />{err && <div className="notice bad">{err}</div>}</>;
  return (
    <div className="mode-sim row between">
      <span>Simulated PayPal approval. Add sandbox credentials to use real PayPal checkout.</span>
      <button className="btn primary" onClick={simulate}>Approve the hold</button>
      {err && <div className="notice bad">{err}</div>}
    </div>
  );
}

function MilestoneCard({ m, pact, act }: { m: MilestoneView; pact: PactView; act: (p: string, b?: unknown) => Promise<void> }) {
  const v = m.verifications.at(-1);
  const base = `/milestones/${m.id}`;
  const tone = STATUS[m.status];
  const canSubmit = pact.status === 'ACTIVE' && pact.role === 'worker' && ['OPEN', 'FAILED', 'HELD'].includes(m.status);

  return (
    <section className="card" aria-label={m.title}>
      <div className="ms-top">
        <div>
          <h2>{m.title}</h2>
          <div className="row" style={{ marginTop: 4 }}>
            <span className={`pill ${tone?.tone}`}>{tone?.label}</span>
            {m.due_at && <span className="tiny muted">Due {new Date(m.due_at).toLocaleDateString()}</span>}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="ms-amount">{money(m.amount_cents, pact.currency)}</div>
          {m.awarded_cents != null && m.awarded_cents !== m.amount_cents && <div className="small muted num">Awarded {money(m.awarded_cents, pact.currency)}</div>}
        </div>
      </div>

      <div className="crit">
        {m.criteria.map((c) => {
          const r = v?.results.find((x) => x.criterion_id === c.id);
          return (
            <div key={c.id}>
              <span className={`mark ${!r ? 'wait' : r.passed ? 'yes' : 'no'}`} aria-label={!r ? 'Not reviewed' : r.passed ? 'Met' : 'Not met'}>{r && <Tick yes={r.passed} />}</span>
              <div>
                <div className="small">{c.text}</div>
                {r && <div className="tiny muted" style={{ marginTop: 2 }}>{r.machine ? 'Measured' : `AI review, ${Math.round(r.confidence * 100)}% sure`}: {r.reason}</div>}
                {r?.evidence && !r.machine && <div className="quote">“{r.evidence}”{!r.evidence_verified && ' (quote not found in the work)'}</div>}
              </div>
            </div>
          );
        })}
      </div>

      {m.status === 'VERIFYING' && <p className="thinking" style={{ marginTop: 12 }}>Checking the work against the contract</p>}
      {v && <Review v={v} status={m.status} />}
      {m.status === 'PASSED' && <Countdown at={m.release_at} amount={m.amount_cents} limit={pact.auto_release_max_cents} currency={pact.currency} />}
      {m.status === 'RELEASED' && <PaidNote m={m} pact={pact} />}
      {m.status === 'PAYOUT_FAILED' && (
        <div className="notice bad">The capture succeeded but the payout did not. The money is safe, and retrying will not charge twice.
          <div className="actions"><button className="btn sm" onClick={() => act(`${base}/retry-payout`)}>Retry payout</button></div>
        </div>
      )}

      {(m.tribunal.length > 0 || m.status === 'IN_TRIBUNAL' || m.status === 'ESCALATED') && <Tribunal m={m} pact={pact} />}

      {canSubmit && <SubmitForm base={base} act={act} retry={m.verifications.length > 0} />}
      <Decisions m={m} pact={pact} base={base} act={act} />
    </section>
  );
}

const Tick = ({ yes }: { yes: boolean }) => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={yes ? 'M1.5 5.5 4 8l4.5-6' : 'M2 2l6 6M8 2 2 8'} />
  </svg>
);

function Review({ v, status }: { v: MilestoneView['verifications'][number]; status: string }) {
  const tone = v.shield.length ? 'bad' : v.outcome === 'PASS' ? 'good' : v.outcome === 'FAIL' ? 'bad' : 'warn';
  if (status === 'RELEASED' && !v.shield.length) return null;
  return (
    <div className={`notice ${tone}`}>
      <strong>{v.summary}</strong>
      {v.shield.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {v.shield.map((s, i) => (
            <div key={i} className="shield-hit"><span>{s.technique}</span><code>{s.excerpt}</code></div>
          ))}
        </div>
      )}
      <div className="tiny" style={{ marginTop: 6, opacity: .8 }}>Attempt {v.attempt}. Reviewed by {v.model}.</div>
    </div>
  );
}

function Countdown({ at, amount, limit, currency }: { at: number | null; amount: number; limit: number; currency: string }) {
  const t = useNow();
  if (amount > limit) return <p className="small muted" style={{ marginTop: 10 }}>Above the {money(limit, currency)} automatic limit, so the buyer must release this.</p>;
  const left = Math.max(0, Math.ceil(((at ?? 0) - t) / 1000));
  return <p className="small num" style={{ marginTop: 10 }}>{left > 0 ? `Pays automatically in ${left >= 3600 ? `${Math.ceil(left / 3600)}h` : `${left}s`} unless the buyer objects.` : 'Releasing now…'}</p>;
}

function PaidNote({ m, pact }: { m: MilestoneView; pact: PactView }) {
  const refs = pact.ledger.filter((r) => r.milestone_id === m.id && (r.type === 'CAPTURED' || r.type === 'PAID_OUT'));
  return (
    <div className="notice good">
      <strong>{money(m.awarded_cents ?? 0, pact.currency)} released.</strong>
      {refs.map((r) => <div key={r.seq} className="tiny" style={{ marginTop: 4 }}>{LEDGER_LABEL[r.type]}: {money(r.amount_cents ?? 0, pact.currency)} · <span className="hash">{r.paypal_ref}</span></div>)}
    </div>
  );
}

function SubmitForm({ base, act, retry }: { base: string; act: (p: string, b?: unknown) => Promise<void>; retry: boolean }) {
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ marginTop: 16 }}>
      <label className="field">{retry ? 'Submit again' : 'Deliver the work'}
        <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the deliverable" />
      </label>
      <label className="field" style={{ marginTop: 10 }}>Link (optional)
        <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
      </label>
      <div className="actions">
        <button className="btn primary" disabled={busy || !text.trim()} onClick={async () => {
          setBusy(true);
          await act(`${base}/submit`, { text, url: url || null });
          setBusy(false);
        }}>{busy ? 'Reviewing…' : 'Submit for review'}</button>
        <span className="small muted">Samples:</span>
        {SAMPLE_WORK.map((s) => <button key={s.name} className="btn sm" onClick={() => setText(s.text)}>{s.name}</button>)}
      </div>
    </div>
  );
}

function Decisions({ m, pact, base, act }: { m: MilestoneView; pact: PactView; base: string; act: (p: string, b?: unknown) => Promise<void> }) {
  const [statement, setStatement] = useState('');
  const [open, setOpen] = useState(false);
  const role = pact.role;
  if (!role || pact.status !== 'ACTIVE') return null;

  if (m.status === 'CONTESTED') {
    const mine = m.contest_by === role;
    return (
      <div className="notice warn">
        <strong>{m.contest_by === 'buyer' ? pact.buyer_name : pact.worker_name} opened a dispute:</strong> {m.contest_statement}
        {mine ? <p style={{ marginTop: 6 }}>Waiting for the other side. The tribunal convenes on its own if they do not answer in time.</p> : (
          <>
            <textarea className="plain" rows={3} style={{ marginTop: 10 }} aria-label="Your response" value={statement} onChange={(e) => setStatement(e.target.value)} />
            <div className="actions">
              <button className="btn primary" disabled={!statement.trim()} onClick={() => act(`${base}/respond`, { statement })}>Respond and convene the tribunal</button>
              <button className="btn sm" onClick={() => setStatement(role === 'buyer' ? BUYER_COMPLAINT : WORKER_REPLY)}>Use sample</button>
            </div>
          </>
        )}
      </div>
    );
  }

  const canReconvene = m.status === 'ESCALATED' && !!m.contest_by;
  const canApprove = role === 'buyer' && ['PASSED', 'FAILED', 'HELD', 'ESCALATED'].includes(m.status);
  const canContest = !!pact.ai_arbitration && (role === 'buyer' ? ['PASSED', 'HELD'] : ['FAILED', 'HELD']).includes(m.status);
  const canWithdraw = role === 'worker' && ['OPEN', 'FAILED', 'HELD', 'ESCALATED'].includes(m.status);
  if (!canApprove && !canContest && !canWithdraw && !canReconvene) return null;

  return (
    <>
      <div className="actions">
        {canReconvene && <button className="btn" onClick={() => act(`${base}/reconvene`)}>Reconvene the tribunal</button>}
        {canApprove && <button className="btn primary" onClick={() => act(`${base}/approve`)}>Release {money(m.amount_cents, pact.currency)}</button>}
        {canContest && <button className="btn" onClick={() => setOpen(!open)}>Open a dispute</button>}
        {canWithdraw && <button className="btn danger" onClick={() => act(`${base}/forfeit`)}>Withdraw from this milestone</button>}
      </div>
      {open && (
        <div style={{ marginTop: 12 }}>
          <label className="field">What went wrong?
            <textarea rows={3} value={statement} onChange={(e) => setStatement(e.target.value)} />
          </label>
          <div className="actions">
            <button className="btn primary" disabled={!statement.trim()} onClick={() => act(`${base}/contest`, { statement })}>File the dispute</button>
            <button className="btn sm" onClick={() => setStatement(role === 'buyer' ? BUYER_COMPLAINT : WORKER_REPLY)}>Use sample</button>
          </div>
        </div>
      )}
    </>
  );
}

function Tribunal({ m, pact }: { m: MilestoneView; pact: PactView }) {
  const lane = (who: 'advocate_worker' | 'advocate_buyer') => m.tribunal.filter((s) => s.speaker === who);
  const judge = m.tribunal.find((s) => s.speaker === 'judge');
  const verdict = pact.ledger.find((r) => r.milestone_id === m.id && r.type === 'VERDICT');
  const inSession = m.status === 'IN_TRIBUNAL' || m.status === 'CONTESTED';

  const Lane = ({ who, name, cls }: { who: 'advocate_worker' | 'advocate_buyer'; name: string; cls: string }) => (
    <div className="lane">
      <div className="who"><span className={`face ${cls}`}>{name[0]}</span> Advocate for {name}</div>
      {lane(who).map((s) => <div key={s.id} className="speech"><b>{s.round}</b>{s.text}</div>)}
      {inSession && lane(who).length < 2 && <span className="thinking">Preparing argument</span>}
    </div>
  );

  return (
    <div className="court" aria-label="Tribunal">
      <div className="row between"><h3>Tribunal</h3>{m.tribunal[0] && <span className="tiny muted">{m.tribunal[0].model}</span>}</div>
      <div className="lanes">
        <Lane who="advocate_worker" name={pact.worker_name} cls="worker" />
        <Lane who="advocate_buyer" name={pact.buyer_name} cls="buyer" />
      </div>
      {inSession && lane('advocate_buyer').length === 2 && !judge && <span className="thinking">The arbiter is writing the ruling</span>}
      {judge && (
        <div className="ruling">
          <div className="who" style={{ marginBottom: 8 }}><span className="face judge">A</span> Arbiter's ruling</div>
          <p className="small">{judge.text}</p>
          {verdict && (
            <div className="row between" style={{ marginTop: 12 }}>
              <span className="small muted">Awarded to {pact.worker_name}</span>
              <span className="money" style={{ fontSize: 24 }}>{money(verdict.amount_cents ?? 0, pact.currency)}</span>
            </div>
          )}
        </div>
      )}
      {m.status === 'ESCALATED' && <div className="notice warn" style={{ marginTop: 0 }}>The tribunal could not reach a ruling, so no money moved. Run it again, or settle this between you.</div>}
    </div>
  );
}

function Trail({ pact }: { pact: PactView }) {
  const rows = [...pact.ledger].reverse().filter((r) => r.type !== 'TRIBUNAL_STEP');
  return (
    <aside className="card" aria-label="Audit trail" style={{ position: 'sticky', top: 16, maxHeight: 'calc(100vh - 32px)', overflowY: 'auto' }}>
      <div className="row between">
        <h2>Audit trail</h2>
        <span className={`pill ${pact.chain.intact ? 'positive' : 'negative'}`}>{pact.chain.intact ? 'Chain intact' : 'Tampered'}</span>
      </div>
      <p className="tiny muted" style={{ margin: '4px 0 10px' }}>Each entry is hashed with the one before it, so changing history breaks the chain.</p>
      <div className="timeline">
        {rows.map((r) => (
          <div key={r.seq}>
            <div>
              {LEDGER_LABEL[r.type] ?? r.type}
              {r.paypal_ref && <div className="ref">{r.paypal_ref}</div>}
            </div>
            <span className="num muted">{r.amount_cents != null ? money(r.amount_cents, pact.currency) : ''}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
