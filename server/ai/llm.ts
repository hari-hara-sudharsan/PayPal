import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { config } from '../config';
import { chargeModelCall } from '../limits';

export type Provider = 'claude' | 'openai-compatible' | 'offline';

export const provider = (): Provider => {
  if (config.ai.forceOffline) return 'offline';
  if (config.ai.anthropicKey) return 'claude';
  if (config.ai.openaiKey) return 'openai-compatible';
  return 'offline';
};

export const modelName = (): string => {
  const p = provider();
  if (p === 'offline') return 'offline-rules';
  return config.ai.model || (p === 'claude' ? 'claude-opus-5-5' : 'gpt-4.1');
};

let claude: Anthropic | null = null;

async function askClaude<S extends z.ZodType>(schema: S, system: string, user: string): Promise<z.infer<S>> {
  claude ??= new Anthropic({ apiKey: config.ai.anthropicKey });
  const message = await claude.beta.messages.parse({
    model: modelName(),
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: betaZodOutputFormat(schema) },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content: user }],
  } as Parameters<typeof claude.beta.messages.parse>[0]);
  if (message.stop_reason === 'refusal') throw new Error('Model declined the request');
  if (!message.parsed_output) throw new Error(`No structured output (stop_reason: ${message.stop_reason})`);
  return message.parsed_output as z.infer<S>;
}

/** Pulls a JSON object out of a reply that may carry reasoning or a code fence around it. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object in model reply');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = 800;

/** Hosted models fail briefly and often. Only a failure that persists should stop a hearing. */
async function postChat(body: unknown): Promise<{ choices: { message: { content: string } }[] }> {
  let failure = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, BACKOFF_MS * 2 ** (attempt - 1)));
    try {
      const res = await fetch(`${config.ai.openaiBase}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${config.ai.openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return await res.json() as { choices: { message: { content: string } }[] };
      failure = `AI endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (!RETRYABLE.has(res.status)) break;
    } catch (err) {
      failure = `AI endpoint unreachable: ${(err as Error).message}`;
    }
  }
  throw new Error(failure);
}

async function askCompatible<S extends z.ZodType>(schema: S, system: string, user: string): Promise<z.infer<S>> {
  const shape = JSON.stringify(z.toJSONSchema(schema));
  const messages = [
    { role: 'system', content: `${system}\n\nRespond with one JSON object and nothing else. It must match this JSON Schema:\n${shape}` },
    { role: 'user', content: user },
  ];
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = await postChat({ model: modelName(), max_tokens: 4096, temperature: 0.2, messages });
    const content = body.choices[0]?.message.content ?? '';
    try {
      return schema.parse(extractJson(content));
    } catch (err) {
      lastError = err;
      messages.push({ role: 'assistant', content }, { role: 'user', content: `That reply was invalid: ${String(err).slice(0, 300)}. Send only the corrected JSON object.` });
    }
  }
  throw lastError;
}

/**
 * One structured model call. `offline` runs only when no AI is configured.
 * A configured provider that fails throws, so callers can fail closed instead of guessing.
 */
export async function ask<S extends z.ZodType>(
  schema: S, system: string, user: string, offline: () => z.infer<S>,
): Promise<z.infer<S>> {
  const p = provider();
  if (p === 'offline') return offline();
  await chargeModelCall();
  return p === 'claude' ? askClaude(schema, system, user) : askCompatible(schema, system, user);
}
