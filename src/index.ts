/**
 * Auto review model selection and output repair for DeepSeek Harness.
 *
 * The shipped Auto review gate decides the reviewer route from the Session's
 * latest `request/header`, so the reviewer always inherits the main model, and
 * it reads the reply with a closed JSON protocol a general-purpose model
 * regularly breaks. This plugin listens on the `llm/stream` waterfall:
 *
 * - it may re-dispatch only the `auto-review` request to a configured
 *   provider/model (the waterfall cannot mutate a request in place, and the
 *   gate's request is deep-frozen, so a fresh dispatch is the only way);
 * - it hardens the reviewer's system prompt with a final format reminder;
 * - it normalizes the reply stream with {@link createReviewStream}, so prose,
 *   Markdown fences, `allow` with a `reason`, `low + deny`, and a truncated
 *   finish no longer become `AUTO_REVIEW_FAILED`, and an unreadable reply
 *   degrades to an approval prompt instead of a hard failure.
 *
 * Every knob is optional; with no configuration the plugin only repairs output
 * and keeps the main model as the reviewer.
 *
 * @module dsh-auto-review-model-select
 */

import z from '@deepseek-ai/schemastery';

import {
  HINT,
  REPAIR_INSTRUCTION,
  REVIEW_PURPOSE,
  createReviewStream,
  type Chunk,
} from './repair.ts';

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'auto-review-model-select';

/** Only the LLM service is required. */
export const inject = ['llm'];

/** One live config field projected by a volatile schema entry. */
interface VolatileRef<T> {
  get(): T | undefined;
}

/** A config value that is either a volatile handle or a plain literal. */
type Configured<T> = T | VolatileRef<T>;

/** The row's configuration, as the Loader hands it to `apply`. */
export interface HostConfig {
  enabled?: Configured<boolean>;
  provider?: Configured<string>;
  model?: Configured<string>;
  reasoningEffort?: Configured<string>;
  hint?: Configured<boolean>;
  repair?: Configured<boolean>;
  retry?: Configured<number>;
  fallback?: Configured<string>;
}

/** The request fields this plugin reads or rewrites. */
export interface GenerateOptions {
  provider: string;
  model: string;
  system?: string;
  messages: readonly unknown[];
  purpose?: string;
  reasoningEffort?: string;
  [extra: string]: unknown;
}

/** The Host context surface this plugin uses. */
export interface HostContext {
  effect(execute: () => void | (() => void), label?: string): void;
  on(
    event: 'llm/stream',
    listener: (options: GenerateOptions, next: () => AsyncIterable<Chunk>) => AsyncIterable<Chunk>,
  ): () => void;
  llm: { stream(options: GenerateOptions): AsyncIterable<Chunk> };
}

/**
 * Model routes already dispatched by this plugin. A review request we created
 * ourselves must pass through on its second trip through the waterfall.
 */
const selfDispatched = new WeakSet<object>();

/** Read one config value from a volatile handle or a plain literal. */
function read<T>(value: Configured<T> | undefined, fallback: T): T {
  if (value !== null && typeof value === 'object' && typeof (value as VolatileRef<T>).get === 'function') {
    try {
      const current = (value as VolatileRef<T>).get();
      return current === undefined ? fallback : current;
    } catch {
      return fallback;
    }
  }
  return value === undefined ? fallback : (value as T);
}

/** Interpret one boolean-ish config value. */
function flag(value: Configured<boolean> | undefined, fallback: boolean): boolean {
  const raw: unknown = read(value, fallback);
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  if (typeof raw === 'number') return raw !== 0;
  return fallback;
}

/** Interpret one non-negative integer config value. */
function count(value: Configured<number> | undefined, fallback: number, max: number): number {
  const raw = Number(read(value, fallback));
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(0, Math.trunc(raw)));
}

/** Interpret one trimmed string config value. */
function text(value: Configured<string> | undefined): string {
  const raw = read(value, '');
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Install the reviewer route override and the output repair.
 * @param ctx - calling plugin context.
 * @param config - the row's configuration.
 */
export function apply(ctx: HostContext, config: HostConfig = {}): void {
  const route = (): { provider: string; model: string } | undefined => {
    const provider = text(config.provider);
    const model = text(config.model);
    return provider === '' || model === '' ? undefined : { provider, model };
  };

  ctx.effect(
    () =>
      ctx.on('llm/stream', (options, next) => {
        if (options === null || typeof options !== 'object' || options.purpose !== REVIEW_PURPOSE) {
          return next();
        }
        if (selfDispatched.has(options)) return next();
        if (!flag(config.enabled, true)) return next();

        // Everything that can throw is resolved before the first dispatch, so a
        // failure never leaves two streams alive.
        const target = route();
        const effort = text(config.reasoningEffort);
        const hint = flag(config.hint, true) && typeof options.system === 'string' && options.system !== '';
        let base = options;

        if (target !== undefined || effort !== '' || hint) {
          const rewritten: GenerateOptions = { ...options };
          if (target !== undefined) {
            rewritten.provider = target.provider;
            rewritten.model = target.model;
          }
          if (effort !== '') rewritten.reasoningEffort = effort;
          if (hint) rewritten.system = `${options.system ?? ''}\n\n${HINT}`;
          selfDispatched.add(rewritten);
          base = rewritten;
        }

        const stream = base === options ? next() : ctx.llm.stream(base);
        if (!flag(config.repair, true)) return stream;

        return createReviewStream(stream, {
          retry: count(config.retry, 1, 2),
          fallback: text(config.fallback) === 'fail' ? 'fail' : 'deny',
          attempt: async () => {
            const flagged: GenerateOptions = {
              ...base,
              messages: [
                ...base.messages,
                { role: 'user', content: [{ type: 'text', text: REPAIR_INSTRUCTION }] },
              ],
            };
            selfDispatched.add(flagged);
            return ctx.llm.stream(flagged);
          },
        });
      }),
    'auto-review-model-select: review route and repair',
  );
}

/**
 * Configuration schema. Volatile fields update in place, so a settings change
 * applies to the next reviewed call without restarting the plugin.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  reasoningEffort: z.string().default('').volatile(),
  hint: z.boolean().default(true).volatile(),
  repair: z.boolean().default(true).volatile(),
  retry: z.number().min(0).max(2).default(1).volatile(),
  fallback: z.string().default('deny').volatile(),
});
