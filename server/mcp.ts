import { Router, json, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { config } from './config';
import { draftPact, DraftSchema } from './ai/draft';
import * as E from './engine/pacts';
import type { Pact, Role } from './types';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

function authorized(pactId: string, key: string): { pact: Pact; role: Role } {
  const pact = E.getPact(pactId);
  if (!pact) throw new Error('Pact not found');
  if (key === pact.buyer_key) return { pact, role: 'buyer' };
  if (key === pact.worker_key) return { pact, role: 'worker' };
  throw new Error('That key does not belong to this pact');
}

const status = (pact: Pact) => ({
  id: pact.id, title: pact.title, status: pact.status, currency: pact.currency,
  total: pact.total_cents / 100, paid: pact.captured_cents / 100,
  milestones: E.milestonesOf(pact.id).map((m) => ({
    id: m.id, title: m.title, amount: m.amount_cents / 100, status: m.status,
    criteria: m.criteria.map((c) => c.text),
    last_review: E.verificationsOf(m.id).at(-1)?.summary ?? null,
  })),
});

/**
 * Lets any MCP-capable agent hire, or work for, a counterparty through Pact.
 * Agents get the same guardrails as people: a buyer's agent cannot fund a pact (a human must
 * approve at PayPal) and no tool can release money directly.
 */
function buildServer() {
  const server = new McpServer({ name: 'pact', version: '1.0.0' });

  server.registerTool('draft_contract', {
    description: 'Turn an informal agreement into a structured contract with milestones and testable acceptance criteria. Moves no money.',
    inputSchema: { agreement: z.string().describe('The conversation, email, or brief') },
  }, async ({ agreement }) => text(await draftPact(agreement)));

  server.registerTool('create_pact', {
    description: 'Create a pact from a draft. Returns private keys for each party. The worker must sign, then a human buyer approves funding at PayPal.',
    inputSchema: {
      draft: DraftSchema, buyer_email: z.email(), worker_email: z.email(),
      challenge_seconds: z.number().int().min(10).optional(),
    },
  }, async (input) => {
    const pact = E.createPact({ ...input, source_text: 'Created by an agent over MCP' });
    return text({ pact_id: pact.id, buyer_key: pact.buyer_key, worker_key: pact.worker_key, next: 'Worker calls sign_pact, then buyer calls request_funding.' });
  });

  server.registerTool('sign_pact', {
    description: 'Worker accepts the contract terms.',
    inputSchema: { pact_id: z.string(), key: z.string() },
  }, async ({ pact_id, key }) => {
    const { pact, role } = authorized(pact_id, key);
    if (role !== 'worker') throw new Error('Only the worker signs');
    E.signPact(pact);
    return text(status(E.getPact(pact_id)!));
  });

  server.registerTool('request_funding', {
    description: 'Create the PayPal hold and return the link where a human buyer approves it. An agent cannot complete this step alone.',
    inputSchema: { pact_id: z.string(), key: z.string() },
  }, async ({ pact_id, key }) => {
    const { pact, role } = authorized(pact_id, key);
    if (role !== 'buyer') throw new Error('Only the buyer can request funding');
    const { orderId, approveUrl } = await E.createFundingOrder(pact);
    return text({ order_id: orderId, approve_url: approveUrl, human_action_required: true });
  });

  server.registerTool('get_pact', {
    description: 'Read a pact: milestones, acceptance criteria, statuses, and the latest review.',
    inputSchema: { pact_id: z.string(), key: z.string() },
  }, async ({ pact_id, key }) => text(status(authorized(pact_id, key).pact)));

  server.registerTool('submit_work', {
    description: 'Worker submits a deliverable for a milestone. It is reviewed against the contract. Returns the per-criterion result.',
    inputSchema: { pact_id: z.string(), key: z.string(), milestone_id: z.string(), text: z.string(), url: z.url().optional() },
  }, async ({ pact_id, key, milestone_id, text: body, url }) => {
    const { pact, role } = authorized(pact_id, key);
    if (role !== 'worker') throw new Error('Only the worker submits work');
    if (E.getMilestone(milestone_id).pact_id !== pact.id) throw new Error('That milestone belongs to another pact');
    const v = await E.submitWork(milestone_id, body, url ?? null);
    return text({ outcome: v.outcome, summary: v.summary, results: v.results, shield: v.shield });
  });

  return server;
}

export function mcpRouter() {
  const r = Router();
  r.use(json({ limit: '1mb' }));

  r.post('/', async (req: Request, res: Response) => {
    const open = config.paypal.mode === 'sim' && !config.mcpToken;
    if (!open && (!config.mcpToken || req.get('authorization') !== `Bearer ${config.mcpToken}`)) {
      return void res.status(401).json({ error: 'MCP_TOKEN is required' });
    }
    // Stateless: one server per request, so nothing is shared between agents.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const notAllowed = (_q: Request, s: Response) => { s.status(405).json({ error: 'Use POST' }); };
  r.get('/', notAllowed);
  r.delete('/', notAllowed);
  return r;
}
