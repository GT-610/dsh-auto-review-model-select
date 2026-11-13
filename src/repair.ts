/**
 * Output repair for the Auto review gate.
 *
 * The gate in `@deepseek-ai/dsh-experimental-auto-review` reads the reviewer's
 * stream with a closed protocol: zero or more reasoning blocks, exactly one
 * text block holding a strict JSON `{risk, decision[, reason]}`, and a `stop`
 * finish. A general-purpose model regularly breaks that contract (prose around
 * the object, Markdown fences, `allow` with a `reason`, `low + deny`, a
 * truncated or tool-call finish). Those cases surface as `AUTO_REVIEW_FAILED`,
 * block the tool call, and are not retried.
 *
 * This module normalizes such a stream instead of trusting the prompt: it
 * buffers whatever the model produced, extracts the decision object, coerces
 * it into one of the six legal shapes, and emits exactly one text block plus a
 * synthetic `stop`. Nothing here knows about Cordis, so it is unit-testable.
 *
 * @module dsh-auto-review-model-select/repair
 */

/** `purpose` value the Auto review gate stamps on its requests. */
export const REVIEW_PURPOSE = 'auto-review';

/** Legal risk classes of the reviewer protocol. */
const RISKS = ['low', 'medium', 'high'] as const;

/** One risk class. */
export type Risk = (typeof RISKS)[number];

/** The decision object the gate accepts. */
export interface Decision {
  risk: Risk;
  decision: 'allow' | 'deny';
  reason?: string;
}

/** Result of reading one arbitrary model reply. */
export type ParsedDecision =
  | { ok: true; decision: Decision }
  | { ok: false; detail: string };

/** A text delta chunk. */
export interface TextDelta {
  type: 'text-delta';
  index: number;
  text: string;
}

/** A reasoning delta chunk. */
export interface ReasoningDelta {
  type: 'reasoning-delta';
  index: number;
  text: string;
}

/** A block start chunk. */
export interface BlockStart {
  type: 'block-start';
  index: number;
  blockType: string;
}

/** A block end chunk. */
export interface BlockEnd {
  type: 'block-end';
  index: number;
  block: { type: string; text?: string };
}

/** A tool-call delta chunk. */
export interface ToolCallDelta {
  type: 'tool-call-delta';
  index: number;
  id: string;
  name?: string;
  argumentsDelta: string;
}

/** A usage chunk. */
export interface UsageChunk {
  type: 'usage';
  usage: unknown;
}

/** The terminal finish chunk. */
export interface FinishChunk {
  type: 'finish';
  reason: { kind: string; failure?: unknown };
  replayState?: unknown;
}

/** Every chunk this module reads or writes. */
export type Chunk =
  | TextDelta
  | ReasoningDelta
  | BlockStart
  | BlockEnd
  | ToolCallDelta
  | UsageChunk
  | FinishChunk;

/** Why one stream stopped before producing a decision. */
export interface ReviewAttempt {
  text: string;
  toolArguments: string;
  index: number;
  finish?: FinishChunk;
}

/**
 * Appended to the reviewer's system prompt. It repeats the format contract at
 * the end of the system text, where models weight it most.
 */
export const HINT = `FORMAT REMINDER (authoritative): reply with exactly one JSON object and nothing else — no prose, no Markdown, no code fence. Valid shapes: {"risk":"low","decision":"allow"}, {"risk":"medium","decision":"allow"}, {"risk":"medium","decision":"deny"}, {"risk":"high","decision":"deny"}. A "reason" is allowed only with "deny".`;

/** Follow-up user message used for a single protocol-retry attempt. */
export const REPAIR_INSTRUCTION = `FORMAT CORRECTION: the previous reply was not a single JSON object in the required shape. Review the same pending tool call again and answer with exactly one JSON object and nothing else. No prose, no Markdown, no code fence.`;

/** Whether one parsed value is a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse one text as JSON, returning `undefined` instead of throwing. */
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Collect every balanced JSON object/array embedded in free text.
 * @param text - arbitrary model output.
 * @returns each syntactically valid value, in order of appearance.
 */
export function jsonCandidates(text: string): unknown[] {
  const source = String(text);
  const found: unknown[] = [];
  for (let start = 0; start < source.length; start += 1) {
    const opener = source[start];
    if (opener !== '{' && opener !== '[') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) continue;
    const value = tryParse(source.slice(start, end + 1));
    if (value !== undefined) found.push(value);
  }
  return found;
}

/**
 * Coerce one parsed value into a legal decision.
 *
 * Contradictory pairs are resolved fail-closed rather than rejected: `high +
 * allow` becomes a `high` denial, and `low + deny` keeps the denial while
 * moving it to `medium` (the protocol has no legal `low + deny`). An `allow`
 * never keeps a `reason`.
 *
 * @param value - one candidate value.
 * @returns the canonical decision, or `undefined` when the value is unusable.
 */
export function canonicalize(value: unknown): Decision | undefined {
  if (!isRecord(value)) return undefined;
  const risk = typeof value.risk === 'string' ? value.risk.trim().toLowerCase() : '';
  const decision = typeof value.decision === 'string' ? value.decision.trim().toLowerCase() : '';
  if (!(RISKS as readonly string[]).includes(risk)) return undefined;
  if (decision !== 'allow' && decision !== 'deny') return undefined;
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (decision === 'allow') {
    if (risk === 'high') {
      return {
        risk: 'high',
        decision: 'deny',
        reason: reason === '' ? 'A high-risk action cannot be allowed automatically.' : reason,
      };
    }
    return { risk: risk as Risk, decision: 'allow' };
  }
  return {
    risk: risk === 'low' ? 'medium' : (risk as Risk),
    decision: 'deny',
    ...(reason === '' ? {} : { reason }),
  };
}

/**
 * Read the reviewer decision out of one arbitrary model reply.
 * @param text - complete text (or tool-call arguments) the reviewer produced.
 * @returns the decision or why it could not be read.
 */
export function parseDecisionLoose(text: string): ParsedDecision {
  const source = typeof text === 'string' ? text.trim() : '';
  if (source === '') return { ok: false, detail: 'the reviewer returned no text' };

  const direct = canonicalize(tryParse(source));
  if (direct !== undefined) return { ok: true, decision: direct };

  const candidates = jsonCandidates(source);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    for (const item of Array.isArray(candidate) ? candidate : [candidate]) {
      const decision = canonicalize(item);
      if (decision !== undefined) return { ok: true, decision };
    }
  }
  return { ok: false, detail: 'no risk/decision object with a legal shape was found' };
}

/**
 * Build the fail-closed replacement used when no decision can be recovered.
 *
 * `medium + deny` is deliberate: under the `ask` approval policy the gate turns
 * a denial into an approval prompt, so the call degrades to a human decision
 * instead of a hard failure. Under `never` it stays a final denial.
 *
 * @param detail - why the reply was unusable; shown to the user.
 * @returns a legal decision object.
 */
export function fallbackDecision(detail: string): Decision {
  return {
    risk: 'medium',
    decision: 'deny',
    reason: `Auto review could not read a valid decision (${detail}). Approve this call manually if it is safe.`,
  };
}

/**
 * Drain one reviewer stream, forwarding reasoning and usage while buffering the
 * parts the protocol rejects.
 * @param stream - upstream chunks.
 * @returns the buffered text, tool-call arguments, highest block index, and finish chunk.
 */
async function* tee(stream: AsyncIterable<Chunk>): AsyncGenerator<Chunk, ReviewAttempt> {
  let text = '';
  let toolArguments = '';
  let index = -1;
  let finish: FinishChunk | undefined;
  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'finish':
        finish = chunk;
        break;
      case 'usage':
        yield chunk;
        continue;
      case 'reasoning-delta':
        index = Math.max(index, chunk.index);
        yield chunk;
        continue;
      case 'block-start':
        if (chunk.blockType === 'reasoning') {
          index = Math.max(index, chunk.index);
          yield chunk;
        }
        continue;
      case 'block-end':
        if (chunk.block.type === 'reasoning') {
          index = Math.max(index, chunk.index);
          yield chunk;
        }
        continue;
      case 'text-delta':
        index = Math.max(index, chunk.index);
        text += chunk.text;
        continue;
      case 'tool-call-delta':
        index = Math.max(index, chunk.index);
        toolArguments += chunk.argumentsDelta;
        continue;
      default:
        continue;
    }
    break;
  }
  return { text, toolArguments, index, finish };
}

/** Controls for {@link createReviewStream}. */
export interface RepairOptions {
  /** Extra attempts after an unusable reply. */
  retry?: number;
  /** `deny` degrades to a human decision; `fail` keeps the protocol failure. */
  fallback?: 'deny' | 'fail';
  /** Starts one more attempt; called only while a retry remains. */
  attempt?: () => Promise<AsyncIterable<Chunk>>;
}

/**
 * Wrap one reviewer stream in the repair protocol.
 *
 * Error and abort finishes pass through untouched (a provider failure must keep
 * its own message). Every other finish is re-read: the decision is recovered,
 * optionally retried with a correction message, and emitted as one text block
 * followed by `stop`.
 *
 * @param upstream - the reviewer's raw chunk stream.
 * @param options - repair controls.
 * @returns the normalized chunk stream.
 */
export function createReviewStream(
  upstream: AsyncIterable<Chunk>,
  options: RepairOptions = {},
): AsyncIterable<Chunk> {
  const retry = Number.isFinite(options.retry) ? Math.max(0, Math.trunc(options.retry as number)) : 0;
  const fallback = options.fallback === 'fail' ? 'fail' : 'deny';
  const attempt = typeof options.attempt === 'function' ? options.attempt : undefined;

  return (async function* normalize(): AsyncGenerator<Chunk> {
    const first = yield* tee(upstream);
    if (first.finish === undefined) {
      throw new Error('auto-review: the reviewer stream ended without a finish chunk');
    }
    const kind = first.finish.reason.kind;
    if (kind === 'error' || kind === 'aborted') {
      yield first.finish;
      return;
    }

    let source = first.text.trim() === '' ? first.toolArguments : first.text;
    let parsed = parseDecisionLoose(source);
    let highest = first.index;
    let finish = first.finish;

    for (let tries = 0; !parsed.ok && tries < retry && attempt !== undefined; tries += 1) {
      let retryStream: AsyncIterable<Chunk>;
      try {
        retryStream = await attempt();
      } catch {
        // A failed dispatch must not cost the fail-closed fallback: the gate
        // would turn a thrown error into AUTO_REVIEW_FAILED.
        break;
      }
      const next = yield* tee(retryStream);
      if (next.finish === undefined) break;
      const nextKind = next.finish.reason.kind;
      if (nextKind === 'error' || nextKind === 'aborted') {
        yield next.finish;
        return;
      }
      highest = Math.max(highest, next.index);
      finish = next.finish;
      source = next.text.trim() === '' ? next.toolArguments : next.text;
      parsed = parseDecisionLoose(source);
    }

    if (!parsed.ok) {
      if (fallback === 'fail') {
        yield finish;
        return;
      }
      parsed = { ok: true, decision: fallbackDecision(parsed.detail) };
    }

    yield { type: 'text-delta', index: highest + 1, text: JSON.stringify(parsed.decision) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}
