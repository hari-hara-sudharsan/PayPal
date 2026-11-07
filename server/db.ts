import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

export type Arg = string | number | null;

interface Driver {
  all(sql: string, args: Arg[]): Promise<Record<string, unknown>[]>;
  run(sql: string, args: Arg[]): Promise<{ changes: number; lastId: number }>;
  script(sql: string): Promise<void>;
}

const SCHEMA = `
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
  response_statement TEXT, convene_at INTEGER, locked_at INTEGER,
  payout_status TEXT, payout_attempt INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS milestones_pact ON milestones(pact_id);
CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY, milestone_id TEXT, attempt INTEGER, deliverable_text TEXT, deliverable_url TEXT,
  outcome TEXT, results TEXT, shield TEXT, summary TEXT, model TEXT, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS verifications_milestone ON verifications(milestone_id);
CREATE TABLE IF NOT EXISTS tribunal_steps (
  id TEXT PRIMARY KEY, milestone_id TEXT, seq INTEGER, speaker TEXT, round TEXT,
  text TEXT, model TEXT, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS tribunal_milestone ON tribunal_steps(milestone_id);
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, pact_id TEXT, milestone_id TEXT, type TEXT, actor TEXT,
  amount_cents INTEGER, paypal_ref TEXT, detail TEXT, at INTEGER, prev_hash TEXT, hash TEXT,
  UNIQUE (pact_id, prev_hash)
);
CREATE TABLE IF NOT EXISTS sim_kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS rate_hits (k TEXT PRIMARY KEY, n INTEGER);
`;

/** Turso over HTTP: no native modules, so it bundles cleanly into a serverless function. */
async function remoteDriver(): Promise<Driver> {
  const { createClient } = await import('@libsql/client/web');
  const client = createClient({ url: config.db.url, authToken: config.db.token });
  return {
    async all(sql, args) {
      const { columns, rows } = await client.execute({ sql, args });
      return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
    },
    async run(sql, args) {
      const r = await client.execute({ sql, args });
      return { changes: r.rowsAffected, lastId: Number(r.lastInsertRowid ?? 0) };
    },
    script: (sql) => client.executeMultiple(sql),
  };
}

/** Node's built-in SQLite: local runs and tests need no account and no setup. */
async function localDriver(): Promise<Driver> {
  const { DatabaseSync } = await import('node:sqlite');
  if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const local = new DatabaseSync(config.dbPath);
  local.exec('PRAGMA journal_mode = WAL;');
  return {
    all: async (sql, args) => local.prepare(sql).all(...args) as Record<string, unknown>[],
    run: async (sql, args) => {
      const r = local.prepare(sql).run(...args);
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
    script: async (sql) => { local.exec(sql); },
  };
}

const ready: Promise<Driver> = (async () => {
  const driver = await (config.db.url ? remoteDriver() : localDriver());
  await driver.script(SCHEMA);
  // Databases created before these columns existed. SQLite has no ADD COLUMN IF NOT EXISTS.
  for (const column of ['payout_status TEXT', 'payout_attempt INTEGER DEFAULT 0']) {
    await driver.run(`ALTER TABLE milestones ADD COLUMN ${column}`, []).catch(() => {});
  }
  return driver;
})();

export const db = {
  all: async <T>(sql: string, ...args: Arg[]) => (await (await ready).all(sql, args)) as T[],
  get: async <T>(sql: string, ...args: Arg[]) => ((await (await ready).all(sql, args))[0]) as T | undefined,
  run: async (sql: string, ...args: Arg[]) => (await ready).run(sql, args),
};
