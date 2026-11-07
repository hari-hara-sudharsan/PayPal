/**
 * An AI agent hires another agent through Pact over MCP. Run `npm start`, then `npm run agent-demo`.
 * It stops at the one step no agent may take: a human approving the PayPal hold.
 * On the emulator that approval is simulated here, and the script says so.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.PACT_URL ?? 'http://localhost:8787';
const client = new Client({ name: 'procurement-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
  requestInit: process.env.MCP_TOKEN ? { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } } : undefined,
}));

const tool = async <T = any>(name: string, args: Record<string, unknown>): Promise<T> => {
  const res = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
  if (res.isError) throw new Error(res.content[0]!.text);
  return JSON.parse(res.content[0]!.text);
};
const say = (who: string, text: string) => console.log(`\n[${who}] ${text}`);

const { tools } = await client.listTools();
say('buyer agent', `Connected. Tools: ${tools.map((t) => t.name).join(', ')}`);

const draft = await tool('draft_contract', {
  agreement: 'Northwind procurement agent needs a market brief on cold-chain warehousing in Rotterdam. Budget $250, one delivery within 7 days. It must be at least 60 words and must contain the phrase "Port of Rotterdam".',
});
say('buyer agent', `Drafted "${draft.title}": ${draft.milestones.length} milestone(s)`);

const created = await tool('create_pact', { draft, buyer_email: 'procurement@northwind.example', worker_email: 'research-agent@example.com', challenge_seconds: 3600 });
const { pact_id, buyer_key, worker_key } = created;

await tool('sign_pact', { pact_id, key: worker_key });
say('worker agent', 'Read the terms and signed.');

const funding = await tool('request_funding', { pact_id, key: buyer_key });
say('buyer agent', `A person must approve the hold: ${funding.approve_url}`);

const meta = await (await fetch(`${BASE}/api/meta`)).json() as { paypal_mode: string };
if (meta.paypal_mode !== 'sim') {
  say('demo', 'Open the link above and approve in PayPal, then re-run get_pact. Stopping here.');
  process.exit(0);
}
await fetch(`${BASE}/sim-paypal/sim/approve/${funding.order_id}`, { method: "POST" });
await fetch(`${BASE}/api/paypal/return?pact=${pact_id}&token=${funding.order_id}`, { redirect: 'manual' });
say('demo', 'Simulated the human approval (emulator only).');

const pact = await tool('get_pact', { pact_id, key: worker_key });
const milestone = pact.milestones[0];
say('worker agent', `Funds are held (${pact.status}). Working on: ${milestone.title}`);

const result = await tool('submit_work', {
  pact_id, key: worker_key, milestone_id: milestone.id,
  text: 'Market brief. Cold-chain warehousing around the Port of Rotterdam is led by operators serving fresh produce and pharmaceuticals, with the largest clusters at Maasvlakte and Botlek. Capacity remains tight, reefer plug availability drives site selection, and rates vary by temperature band and handling requirements across the Port of Rotterdam area, according to operators in the region. Demand from supermarkets and vaccine distributors keeps occupancy high through the year, so buyers should book capacity early and compare handling fees alongside storage rates.',
});
say('pact', `Review: ${result.outcome}. ${result.summary}`);
say('demo', `Open ${BASE}/p/${pact_id}?k=${buyer_key} to see it as the buyer.`);
await client.close();
