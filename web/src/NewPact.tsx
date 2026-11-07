import { useState } from 'react';
import type { Draft } from '../../server/ai/draft';
import { api, go, keys, money } from './lib';
import { SAMPLE_CHATS } from './samples';

const KIND_LABEL = { judgment: 'AI review', min_words: 'Measured: word count', must_include: 'Measured: exact text', url_live: 'Measured: link loads' };

export function NewPact() {
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [buyerEmail, setBuyerEmail] = useState('buyer@example.com');
  const [workerEmail, setWorkerEmail] = useState('worker@example.com');
  const [challenge, setChallenge] = useState(60);
  const [limit, setLimit] = useState(500);
  const [arbitration, setArbitration] = useState(true);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const generate = () => run(async () => setDraft(await api<Draft>('/drafts', { body: { text } })));

  const create = () => run(async () => {
    const out = await api<{ id: string; buyer_link: string; worker_link: string }>('/pacts', {
      body: { draft, buyer_email: buyerEmail, worker_email: workerEmail, source_text: text, challenge_seconds: challenge, auto_release_max: limit, ai_arbitration: arbitration },
    });
    keys.save(out.id, 'buyer', new URL(out.buyer_link, location.href).searchParams.get('k')!);
    keys.save(out.id, 'worker', new URL(out.worker_link, location.href).searchParams.get('k')!);
    go(out.buyer_link);
  });

  const setMs = (i: number, patch: Partial<Draft['milestones'][number]>) =>
    setDraft((d) => d && { ...d, milestones: d.milestones.map((m, j) => (j === i ? { ...m, ...patch } : m)) });

  const total = draft?.milestones.reduce((s, m) => s + Math.round(m.amount * 100), 0) ?? 0;

  return (
    <div className="stack">
      <div className="head">
        <div>
          <h1>New pact</h1>
          <p>Paste the conversation where you agreed the work. You review everything before anyone signs.</p>
        </div>
      </div>

      <section className="card stack" style={{ gap: 12 }}>
        <label className="field">
          The agreement
          <textarea rows={draft ? 5 : 11} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a chat, email, or brief" />
        </label>
        <div className="row between">
          <div className="row small">
            <span className="muted">Try one:</span>
            {SAMPLE_CHATS.map((s) => <button key={s.name} className="btn sm" onClick={() => setText(s.text)}>{s.name}</button>)}
          </div>
          <button className="btn primary" disabled={busy || text.trim().length < 10} onClick={generate}>
            {busy && !draft ? 'Reading the agreement…' : draft ? 'Draft again' : 'Draft the contract'}
          </button>
        </div>
        {error && <div className="notice bad" role="alert">{error}</div>}
      </section>

      {draft && (
        <div className="split">
          <div className="stack">
            <section className="card">
              <input className="plain" aria-label="Title" style={{ fontSize: 20, fontWeight: 600 }} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              <p className="muted small" style={{ marginTop: 8 }}>{draft.summary}</p>
            </section>
            {draft.milestones.map((m, i) => (
              <section key={i} className="card">
                <div className="ms-top">
                  <input className="plain" aria-label={`Milestone ${i + 1} title`} value={m.title} onChange={(e) => setMs(i, { title: e.target.value })} />
                  <input className="plain num" aria-label={`Milestone ${i + 1} amount`} type="number" min="1" step="0.01" style={{ width: 120, textAlign: 'right' }} value={m.amount} onChange={(e) => setMs(i, { amount: Number(e.target.value) })} />
                </div>
                <div className="crit">
                  {m.criteria.map((c, j) => (
                    <div key={j} style={{ gridTemplateColumns: 'minmax(0,1fr) auto', alignItems: 'start' }}>
                      <span className="small">{c.text}</span>
                      <span className={`pill ${c.kind === 'judgment' ? 'accent' : 'neutral'}`}>{KIND_LABEL[c.kind]}</span>
                    </div>
                  ))}
                </div>
                {m.due_days != null && <p className="tiny muted" style={{ marginTop: 8 }}>Due {m.due_days} days after funding</p>}
              </section>
            ))}
          </div>

          <aside className="stack">
            <section className="card stack" style={{ gap: 12 }}>
              <div><span className="small muted">Total to hold</span><div className="money">{money(total, draft.currency)}</div></div>
              <label className="field">{draft.buyer_name}'s PayPal email<input type="email" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} /></label>
              <label className="field">{draft.worker_name}'s PayPal email<input type="email" value={workerEmail} onChange={(e) => setWorkerEmail(e.target.value)} /></label>
              <label className="field">Time to object after verification
                <select value={challenge} onChange={(e) => setChallenge(Number(e.target.value))}>
                  <option value={60}>1 minute (demo)</option><option value={3600}>1 hour</option><option value={86400}>1 day</option><option value={259200}>3 days</option>
                </select>
              </label>
              <label className="field">Release automatically up to
                <input type="number" min="0" value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
              </label>
              <label className="row small" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                <input type="checkbox" style={{ marginTop: 4 }} checked={arbitration} onChange={(e) => setArbitration(e.target.checked)} />
                <span>Both sides accept the AI tribunal's ruling on disputes</span>
              </label>
              <button className="btn primary" disabled={busy} onClick={create}>Create pact</button>
            </section>

            {draft.clarifications.length > 0 && (
              <section className="card">
                <h3>Made testable</h3>
                <div className="crit">
                  {draft.clarifications.map((c, i) => (
                    <div key={i} style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
                      <span className="small"><s className="muted">{c.vague}</s><br />{c.testable}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {draft.warnings.length > 0 && (
              <div className="notice warn" style={{ marginTop: 0 }}>
                <strong>Settle before signing</strong>
                {draft.warnings.map((w, i) => <p key={i} style={{ marginTop: 6 }}>{w}</p>)}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
