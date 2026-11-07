# Devpost submission kit

Fill in the bracketed items. Before submitting, make sure every claim below is true of what you recorded.

## Tagline

Money that moves when the work is proven.

## Inspiration

Paying a stranger online for work means someone takes the risk. Pay first and the work may never come. Work first and the money may never come. On a $150 job nobody hires a lawyer, so the loser just absorbs it. Meanwhile, AI agents are starting to hire and get hired, and they have even less recourse than people do.

## What it does

Pact turns a chat into an enforceable payment contract. AI writes milestones with testable acceptance criteria. The buyer approves a PayPal authorization, so the money is held but not charged. Delivered work is checked against the contract, and verified milestones are captured and paid out. If either side objects, two AI advocates argue from the record, an AI arbiter rules, and the ruling executes as a partial capture. The unearned share is voided, so that part of the buyer's money never moved.

## How we built it

Node, TypeScript, React, SQLite. PayPal Orders v2 with `intent: AUTHORIZE`, partial captures, void, reauthorize, Payouts, and signature-verified webhooks. AG Grid powers the ledger, including plain-English filtering. An MCP server lets AI agents hire and deliver work. Deployed on Render.

The core design rule is that AI never moves money. Models return findings. Deterministic code decides the outcome, checks every award against the contract, and is the only path to PayPal.

## Challenges

The deliverable is written by the person who gets paid if it passes, so it is hostile input. We built the Shield: deterministic detection of hidden text, invisible Unicode, encoded payloads, and forged verdicts, plus a model screen for attacks phrased in ways patterns miss. A hit blocks automatic release even when the grade is perfect.

## What we learned

A prompt can only ask. Every guarantee that mattered ended up in code: award limits, evidence checks, and even the rule that a "testable" rewrite cannot be an opinion.

## What's next

Appeals, image and file review, and PayPal multiparty onboarding for production use.

## Demo video script (under 3 minutes)

| Time | Show | Say |
| --- | --- | --- |
| 0:00 | Home screen | "Pay first, and the work may never come. Work first, and the money may never come. Pact fixes that with a PayPal feature most apps ignore." |
| 0:20 | Paste the bakery chat, Draft | "Paste the chat. AI writes a contract, and it flags what is too vague to enforce." |
| 0:40 | Sign, then PayPal approval | "The buyer approves a PayPal hold. The money is real, and nothing has been charged." |
| 1:00 | Submit the attack sample | "Now I'm a dishonest worker. I hide an instruction telling the AI to approve me and release the funds." |
| 1:20 | Shield result | "Caught. Even with a perfect grade, this cannot auto-release. AI never moves money. Code does." |
| 1:35 | Submit honest work, buyer disputes | "Now an honest but disputed delivery." |
| 1:50 | Tribunal fills in live | "Two advocates argue from the record. The arbiter splits the milestone." |
| 2:15 | Hold bar and PayPal references | "The verdict just executed. A partial capture, a payout, and the rest was never charged." |
| 2:30 | Ledger, ask a question | "Every decision is in a tamper-evident ledger, built on AG Grid, and you can ask it questions." |
| 2:45 | Agents page | "And agents can hire through Pact, but only a human can approve the money." |

## Checklist

- [ ] Real PayPal sandbox run recorded, with the sidebar showing "Live sandbox"
- [ ] Public GitHub repo with the MIT license visible in the About section
- [ ] Hosted demo URL on Render
- [ ] YouTube video public, under 3 minutes, no copyrighted music
- [ ] Tools section lists the AI model actually used in the recording
