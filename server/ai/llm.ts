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

async function askCompatible<S extends z.ZodType>(schema: S, system: string, user: string): Promise<z.infer<S>> {
  const shape = JSON.stringify(z.toJSONSchema(schema));
  const messages = [
    { role: 'system', content: `${system}\n\nRespond with one JSON object and nothing else. It must match this JSON Schema:\n${shape}` },
    { role: 'user', content: user },
  ];
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${config.ai.openaiBase}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
      headers: { Authorization: `Bearer ${config.ai.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName(), max_tokens: 4096, temperature: 0.2, messages }),
    });
    if (!res.ok) throw new Error(`AI endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json() as { choices: { message: { content: string } }[] };
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
