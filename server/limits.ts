import crypto from 'node:crypto';
import { config } from './config';
import { db } from './db';
import { now } from './clock';

export class LimitReached extends Error {}

const HOUR = 3_600_000;
const DAY = 86_400_000;

async function spend(bucket: string, windowMs: number, cost: number): Promise<number> {
  const key = `${bucket}:${Math.floor(now() / windowMs)}`;
  const row = await db.get<{ n: number }>(
    'INSERT INTO rate_hits (k, n) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET n = n + ? RETURNING n', key, cost, cost,
  );
  return row?.n ?? cost;
}

/** Stops one visitor from using up the demo. The IP is hashed so none are stored. */
export async function chargeVisitor(ip: string, cost: number) {
  const id = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
  if (await spend(`ip:${id}`, HOUR, cost) > config.limits.perVisitorHour) {
    throw new LimitReached('You have reached the hourly demo limit. Please try again later.');
  }
}

/** The hard ceiling on model calls per day, however many visitors there are. */
export async function chargeModelCall() {
  if (await spend('model', DAY, 1) > config.limits.modelCallsPerDay) {
    throw new LimitReached('The daily AI limit for this demo has been reached.');
  }
}
