# Pact

**Money that moves when the work is proven.**

Paying a stranger online for work means someone takes a risk. Pay first and the work may never come. Work first and the money may never come. For small jobs, nobody can afford a lawyer, so the loser just eats it.

Pact removes that risk using a PayPal primitive most apps ignore: the authorization. The buyer's money is held but not charged, and it moves only as work is proven.

1. **Agree.** Paste the chat or email where you agreed the job. AI turns it into milestones with acceptance criteria a neutral party could check, and rewrites vague words like "modern" into something testable.
2. **Hold.** The buyer approves a PayPal authorization for the full amount. The worker can see the money is real. Nothing is charged.
3. **Prove.** The worker delivers. Each criterion is checked, by code where possible and by AI where it takes judgment.
4. **Pay.** Verified milestones are captured and paid out through PayPal after a challenge window.
5. **Dispute.** Either side can contest. Two AI advocates argue from the record, an AI arbiter rules, and the ruling executes as a partial capture. The share the worker did not earn is voided, so **the buyer's money never moved at all.**

## Why you can trust an AI near money

The deliverable is written by the person who gets paid if it passes, so Pact treats it as hostile input. Five rules follow from that:

| Rule | How it is enforced |
| --- | --- |
| **AI never moves money** | Models return findings. The outcome is decided by plain code (`decideOutcome`), and `settle()` is the only path to PayPal. |
| **AI can't exceed the contract** | Every award is checked against the milestone in code, whoever proposed it. |
| **AI can't invent proof** | Each passing grade must quote the deliverable. If the quote is not really there, the milestone is held for a person. |
| **AI failure stops the money** | If the model is down, refuses, or is unsure, nothing is paid and a person is asked. |
| **Attacks are caught, not just ignored** | The Shield finds hidden HTML, invisible Unicode, base64 payloads, forged verdicts, and instruction overrides, then a model screens for what patterns miss. A hit blocks automatic release even if the grade was perfect. |

Try it: on any milestone, pick the **Prompt-injection attack** sample as the worker.

`scripts/eval.ts` runs adversarial deliverables against the real pipeline. The latest run with `nvidia/nemotron-3-ultra-550b-a55b` got 9 of 9 right: honest work passed, and none of the 8 attacks or padded deliverables reached a payable state. It is a small set, so read it as a regression check and not as a guarantee.

## PayPal integration

| Capability | API | Used for |
| --- | --- | --- |
| Orders v2, `intent: AUTHORIZE` | `POST /v2/checkout/orders`, `/authorize` | Holding funds without charging |
| JS SDK Buttons | `intent=authorize` | Buyer approval |
| Partial capture | `POST /v2/payments/authorizations/{id}/capture` | One capture per milestone, against one hold |
| Void | `POST /v2/payments/authorizations/{id}/void` | Returning the unearned balance |
| Reauthorize | `POST /v2/payments/authorizations/{id}/reauthorize` | Renewing the hold after the 3-day honor period |
| Payouts | `POST /v1/payments/payouts` | Paying the worker |
| Webhooks | `POST /v1/notifications/verify-webhook-signature` | Signature-verified events into the ledger |

Each money movement uses a `PayPal-Request-Id` derived from the milestone, so a crash and retry replays the operation and cannot pay twice. A compare-and-set on milestone status stops concurrent double release.

## Agents

Pact is an MCP server at `/mcp`, so an AI agent can hire, or get hired, under the same guardrails. An agent can draft, sign, deliver, and read status. It cannot fund a pact, because funding stops at a PayPal link a person must approve, and no tool releases money. `npm run agent-demo` shows one agent hiring another.

## Run it

Requires Node 22.13 or newer.

```bash
npm install
cp .env.example .env     # optional: everything works with it empty
npm run build
npm start                # http://localhost:8787
```

With no credentials, Pact runs on a built-in PayPal emulator and offline rules. Both are labelled in the sidebar, so you always know what is real.

| To use | Set |
| --- | --- |
| Real PayPal sandbox | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` |
| Claude | `ANTHROPIC_API_KEY` |
| Any OpenAI-compatible model | `OPENAI_API_KEY`, `OPENAI_API_BASE`, `AI_MODEL` |

Deploy on Render with the included `render.yaml`.

```bash
npm test                 # engine, Shield, and money-safety tests
npm run typecheck
npx tsx scripts/eval.ts  # adversarial eval, against a running server
```

## Tools used

- **PayPal REST APIs and JS SDK:** see the table above.
- **AI model:** Claude (`claude-opus-5-5`) through the Anthropic SDK, or any OpenAI-compatible model. Tested end to end with `nvidia/nemotron-3-ultra-550b-a55b`. Used for contract drafting, judgment criteria, the injection screen, the tribunal, and plain-English ledger search.
- **AG Grid:** the ledger, with AI-driven external filtering, live totals over filtered rows, and CSV export.
- **Render:** hosting, through the included blueprint.
- **Model Context Protocol:** the agent interface.

## Honest limits

- **Hold length.** PayPal authorizations last 29 days, so longer work should be split into separate pacts. Pact warns about this when drafting.
- **Who can use this in production.** Holding and paying out for others is regulated. This is a sandbox prototype, and a real launch would need PayPal's multiparty onboarding and legal review.
- **AI arbitration is opt-in** and low-confidence rulings go to a person, but there is no appeals process yet.
- **Deliverables are text and links.** Images and files are not reviewed yet.
- **Data.** The Render blueprint uses temporary storage, which resets on redeploy.

## License

MIT
