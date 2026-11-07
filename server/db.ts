import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS pacts (
  id TEXT PRIMARY KEY, title TEXT, summary TEXT, currency TEXT, total_cents INTEGER,
  buyer_name TEXT, buyer_email TEXT, worker_name TEXT, worker_email TEXT,
  buyer_key TEXT, worker_key TEXT, terms_hash TEXT, status TEXT,
  challenge_seconds INTEGER, auto_release_max_cents INTEGER, ai_arbitration INTEGER,
  source_text TEXT, order_id TEXT, auth_id TEXT, honor_expires_at INTEGER, auth_expires_at INTEGER,
  captured_cents INTEGER DEFAULT 0, signed_at INTEGER, funded_at INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY, pact_id TEXT, idx INTEGER, title TEXT, amount_cents INTEGER, due_at INTEGER,
  criteria TEXT, status TEXT, release_at INTEGER, awarded_cents INTEGER,
  capture_id TEXT, payout_id TEXT, contest_by TEXT, contest_statement TEXT,
  response_statement TEXT, convene_at INTEGER
);
CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY, milestone_id TEXT, attempt INTEGER, deliverable_text TEXT, deliverable_url TEXT,
  outcome TEXT, results TEXT, shield TEXT, summary TEXT, model TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS tribunal_steps (
  id TEXT PRIMARY KEY, milestone_id TEXT, seq INTEGER, speaker TEXT, round TEXT,
  text TEXT, model TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, pact_id TEXT, milestone_id TEXT, type TEXT, actor TEXT,
  amount_cents INTEGER, paypal_ref TEXT, detail TEXT, at INTEGER, prev_hash TEXT, hash TEXT
);
CREATE INDEX IF NOT EXISTS ledger_pact ON ledger(pact_id);
CREATE TABLE IF NOT EXISTS sim_kv (k TEXT PRIMARY KEY, v TEXT);
`);
