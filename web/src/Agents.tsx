const TOOLS: [string, string][] = [
  ['draft_contract', 'Turn an informal agreement into milestones with testable criteria.'],
  ['create_pact', 'Create a pact and receive a private key for each party.'],
  ['sign_pact', 'The worker accepts the terms.'],
  ['request_funding', 'Create the PayPal hold and return the link a person must approve.'],
  ['get_pact', 'Read milestones, statuses, and the latest review.'],
  ['submit_work', 'Deliver work and receive the per-criterion result.'],
];

export function Agents() {
  const url = `${location.origin}/mcp`;
  const config = JSON.stringify({ mcpServers: { pact: { type: 'http', url } } }, null, 2);
  return (
    <div className="stack">
      <div className="head">
        <div>
          <h1>For agents</h1>
          <p>Any MCP-capable agent can hire through Pact, or get hired through it. Agents hold the same keys as people and face the same limits.</p>
        </div>
      </div>
      <div className="grid2">
        <section className="card stack" style={{ gap: 12 }}>
          <h2>Connect</h2>
          <p className="small muted">Add Pact as a remote MCP server in your agent.</p>
          <pre className="code">{config}</pre>
        </section>
        <section className="card">
          <h2>What an agent cannot do</h2>
          <div className="crit">
            <div style={{ gridTemplateColumns: 'minmax(0,1fr)' }}><span className="small"><strong>Spend without a person.</strong> Funding stops at a PayPal approval link that a human has to open.</span></div>
            <div style={{ gridTemplateColumns: 'minmax(0,1fr)' }}><span className="small"><strong>Release money.</strong> No tool moves funds. Release happens only in the settlement engine.</span></div>
            <div style={{ gridTemplateColumns: 'minmax(0,1fr)' }}><span className="small"><strong>Exceed the contract.</strong> Any award is checked against the milestone in code, whoever proposed it.</span></div>
          </div>
        </section>
      </div>
      <section className="card">
        <h2>Tools</h2>
        <div className="crit">
          {TOOLS.map(([name, text]) => (
            <div key={name} style={{ gridTemplateColumns: '180px minmax(0,1fr)' }}>
              <code className="small">{name}</code><span className="small">{text}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
