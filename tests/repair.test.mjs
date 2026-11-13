import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalize,
  createReviewStream,
  fallbackDecision,
  parseDecisionLoose,
} from '../src/repair.ts';

/** Collect every chunk one review stream emits. */
async function drain(stream) {
  const collected = [];
  for await (const chunk of stream) collected.push(chunk);
  return collected;
}

/** Turn a list of chunks into an async iterable, like an adapter stream. */
async function* chunks(list) {
  for (const chunk of list) yield chunk;
}

/** Build the single text block one repaired stream must end with. */
function textOf(output) {
  const block = output.find((chunk) => chunk.type === 'text-delta');
  return block === undefined ? undefined : block.text;
}

test('accepts a clean decision object', () => {
  const result = parseDecisionLoose('{"risk":"low","decision":"allow"}');
  assert.deepEqual(result, { ok: true, decision: { risk: 'low', decision: 'allow' } });
});

test('reads through Markdown fences and prose', () => {
  const reply = 'Sure, here is my review:\n```json\n{"risk":"medium","decision":"allow"}\n```\nDone.';
  assert.deepEqual(parseDecisionLoose(reply), {
    ok: true,
    decision: { risk: 'medium', decision: 'allow' },
  });
});

test('scans a reason that holds braces and quotes', () => {
  const reply = '{"risk":"low","decision":"deny","reason":"a } brace and a \\"quoted\\" word"}';
  assert.equal(parseDecisionLoose(reply).decision.reason, 'a } brace and a "quoted" word');
});

test('takes the last usable object when the model restates itself', () => {
  const reply = '{"risk":"low","decision":"allow"} ... actually {"risk":"high","decision":"deny","reason":"secret exfiltration"}';
  const result = parseDecisionLoose(reply);
  assert.equal(result.ok, true);
  assert.deepEqual(result.decision, {
    risk: 'high',
    decision: 'deny',
    reason: 'secret exfiltration',
  });
});

test('drops a reason attached to allow', () => {
  assert.deepEqual(canonicalize({ risk: 'medium', decision: 'allow', reason: 'fine' }), {
    risk: 'medium',
    decision: 'allow',
  });
});

test('keeps a low-risk denial as a legal medium denial', () => {
  assert.deepEqual(canonicalize({ risk: 'low', decision: 'deny', reason: 'nope' }), {
    risk: 'medium',
    decision: 'deny',
    reason: 'nope',
  });
});

test('turns high + allow into a high denial', () => {
  assert.deepEqual(canonicalize({ risk: 'high', decision: 'allow' }), {
    risk: 'high',
    decision: 'deny',
    reason: 'A high-risk action cannot be allowed automatically.',
  });
});

test('normalizes case and surrounding whitespace', () => {
  assert.deepEqual(canonicalize({ risk: ' High ', decision: ' DENY ' }), {
    risk: 'high',
    decision: 'deny',
  });
});

test('rejects an object without a legal enum pair', () => {
  assert.equal(canonicalize({ risk: 'critical', decision: 'deny' }), undefined);
  assert.equal(canonicalize({ risk: 'low' }), undefined);
  assert.equal(parseDecisionLoose('I cannot help with that.').ok, false);
});

test('finds objects embedded after a JSON array wrapper', () => {
  const result = parseDecisionLoose('[{"risk":"low","decision":"allow"}]');
  assert.deepEqual(result.decision, { risk: 'low', decision: 'allow' });
});

test('the fallback is a legal fail-closed decision', () => {
  const decision = fallbackDecision('empty output');
  assert.equal(decision.risk, 'medium');
  assert.equal(decision.decision, 'deny');
  assert.match(decision.reason, /empty output/);
});

test('repairs a prose reply into one text block and a stop finish', async () => {
  const upstream = chunks([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Here you go: {"risk":"low",' },
    { type: 'text-delta', index: 0, text: '"decision":"allow"}' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Here you go: {"risk":"low","decision":"allow"}' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const output = await drain(createReviewStream(upstream));
  assert.deepEqual(textOf(output), '{"risk":"low","decision":"allow"}');
  assert.equal(output.at(-1).type, 'finish');
  assert.deepEqual(output.at(-1).reason, { kind: 'stop' });
  assert.equal(output.filter((chunk) => chunk.type === 'text-delta').length, 1);
});

test('forwards reasoning blocks and drops rejected text blocks', async () => {
  const upstream = chunks([
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '{"risk":"medium","decision":"deny"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const output = await drain(createReviewStream(upstream));
  assert.equal(output[0].type, 'block-start');
  assert.equal(output[0].blockType, 'reasoning');
  const text = output.find((chunk) => chunk.type === 'text-delta');
  assert.equal(text.index, 2);
  assert.equal(text.text, '{"risk":"medium","decision":"deny"}');
});

test('salvages a max-tokens finish that already holds a full object', async () => {
  const upstream = chunks([
    { type: 'text-delta', index: 0, text: '{"risk":"low","decision":"allow"}' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]);
  const output = await drain(createReviewStream(upstream));
  assert.deepEqual(output.at(-1).reason, { kind: 'stop' });
});

test('reads a tool-call shaped review', async () => {
  const upstream = chunks([
    { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'submit_review', argumentsDelta: '{"risk":"medium",' },
    { type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: '"decision":"allow"}' },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]);
  const output = await drain(createReviewStream(upstream));
  assert.deepEqual(textOf(output), '{"risk":"medium","decision":"allow"}');
  assert.deepEqual(output.at(-1).reason, { kind: 'stop' });
});

test('leaves provider errors untouched', async () => {
  const failure = { code: 'RATE_LIMITED', message: 'slow down' };
  const upstream = chunks([
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure } },
  ]);
  const output = await drain(createReviewStream(upstream));
  assert.deepEqual(output, [{ type: 'finish', reason: { kind: 'error', failure } }]);
});

test('degrades an unreadable reply to a denial that can be approved', async () => {
  const upstream = chunks([
    { type: 'text-delta', index: 0, text: 'I am not sure about this one.' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const output = await drain(createReviewStream(upstream, { fallback: 'deny' }));
  const decision = JSON.parse(textOf(output));
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.risk, 'medium');
  assert.deepEqual(output.at(-1).reason, { kind: 'stop' });
});

test('keeps the failure when fallback is fail', async () => {
  const upstream = chunks([
    { type: 'text-delta', index: 0, text: 'I am not sure about this one.' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const output = await drain(createReviewStream(upstream, { fallback: 'fail' }));
  assert.equal(output.filter((chunk) => chunk.type === 'text-delta').length, 0);
  assert.deepEqual(output.at(-1).reason, { kind: 'stop' });
});

test('retries once with a correction and uses the second reply', async () => {
  let attempts = 0;
  const stream = createReviewStream(
    chunks([{ type: 'text-delta', index: 0, text: 'no decision' }, { type: 'finish', reason: { kind: 'stop' } }]),
    {
      retry: 1,
      attempt: async () => {
        attempts += 1;
        return chunks([
          { type: 'text-delta', index: 0, text: '{"risk":"high","decision":"deny","reason":"secrets"}' },
          { type: 'finish', reason: { kind: 'stop' } },
        ]);
      },
    },
  );
  const output = await drain(stream);
  assert.equal(attempts, 1);
  assert.deepEqual(JSON.parse(textOf(output)), {
    risk: 'high',
    decision: 'deny',
    reason: 'secrets',
  });
});

test('falls back when the retry dispatch throws', async () => {
  const stream = createReviewStream(
    chunks([{ type: 'text-delta', index: 0, text: 'no decision' }, { type: 'finish', reason: { kind: 'stop' } }]),
    {
      retry: 1,
      attempt: async () => {
        throw new Error('provider unavailable');
      },
      fallback: 'deny',
    },
  );
  const output = await drain(stream);
  const decision = JSON.parse(textOf(output));
  assert.equal(decision.risk, 'medium');
  assert.equal(decision.decision, 'deny');
  assert.deepEqual(output.at(-1).reason, { kind: 'stop' });
});

test('keeps the fallback text clear of a retry stream that never finishes', async () => {
  const stream = createReviewStream(
    chunks([{ type: 'text-delta', index: 0, text: 'no decision' }, { type: 'finish', reason: { kind: 'stop' } }]),
    {
      retry: 1,
      fallback: 'deny',
      attempt: async () =>
        chunks([
          { type: 'block-start', index: 1, blockType: 'reasoning' },
          { type: 'reasoning-delta', index: 1, text: 'thinking' },
        ]),
    },
  );
  const output = await drain(stream);

  const blocks = output.filter((chunk) => chunk.type === 'block-start');
  assert.deepEqual(
    blocks.map((chunk) => [chunk.blockType, chunk.index]),
    [['reasoning', 1]],
  );
  const text = output.find((chunk) => chunk.type === 'text-delta');
  assert.equal(text.index, 2, 'the fallback text must not share the reasoning index');
  assert.equal(JSON.parse(text.text).decision, 'deny');
});

test('throws when the upstream never settles', async () => {
  await assert.rejects(
    drain(createReviewStream(chunks([{ type: 'text-delta', index: 0, text: 'x' }]))),
    /without a finish chunk/,
  );
});
