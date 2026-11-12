import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../src/index.ts';

/** Build the chunk list one reviewer attempt streams. */
function attempt(reply, reason = { kind: 'stop' }) {
  return [
    { type: 'text-delta', index: 0, text: reply },
    { type: 'finish', reason },
  ];
}

/** Collect a chunk stream into an array. */
async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/**
 * Build a context whose `llm.stream` re-enters the registered waterfall
 * listener, exactly like the LlmRuntime does.
 */
function harness(adapter) {
  let listener;
  const ctx = {
    on(event, fn) {
      assert.equal(event, 'llm/stream');
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    effect(fn) {
      const cleanup = fn();
      return typeof cleanup === 'function' ? cleanup : () => {};
    },
    llm: {
      stream(options) {
        return listener === undefined ? adapter(options) : listener(options, () => adapter(options));
      },
    },
  };
  return {
    ctx,
    dispatch: (options) => ctx.llm.stream(options),
  };
}

/** One review request shaped like the Auto review gate's. */
function reviewRequest() {
  return {
    provider: 'main-provider',
    model: 'main-model',
    purpose: 'auto-review',
    temperature: 0,
    sessionId: 'session-1',
    system: 'REVIEW_POLICY',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ENVIRONMENT' }] }],
  };
}

test('leaves non-review requests untouched', async () => {
  const seen = [];
  const { ctx, dispatch } = harness((options) => {
    seen.push(options);
    return (async function* raw() {
      yield { type: 'text-delta', index: 0, text: 'hello' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  });
  apply(ctx, {});
  const request = { ...reviewRequest(), purpose: 'chat' };
  const output = await drain(dispatch(request));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].purpose, 'chat');
  assert.equal(output[0].text, 'hello');
});

test('normalizes a review reply without touching the route', async () => {
  const seen = [];
  const { ctx, dispatch } = harness((options) => {
    seen.push(options);
    return (async function* raw() {
      for (const chunk of attempt('Here: ```json\n{"risk":"low","decision":"allow"}\n```')) yield chunk;
    })();
  });
  apply(ctx, {});
  const output = await drain(dispatch(reviewRequest()));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].provider, 'main-provider');
  assert.deepEqual(JSON.parse(output.find((chunk) => chunk.type === 'text-delta').text), {
    risk: 'low',
    decision: 'allow',
  });
  assert.deepEqual(output.at(-1).reason, { kind: 'stop' });
});

test('re-dispatches the review to a configured model exactly once', async () => {
  const seen = [];
  const { ctx, dispatch } = harness((options) => {
    seen.push(options);
    return (async function* raw() {
      for (const chunk of attempt('{"risk":"medium","decision":"allow"}')) yield chunk;
    })();
  });
  apply(ctx, { provider: 'cheap-provider', model: 'small-model', reasoningEffort: 'low' });
  const output = await drain(dispatch(reviewRequest()));

  assert.equal(seen.length, 1, 'the inner dispatch must not loop');
  assert.equal(seen[0].provider, 'cheap-provider');
  assert.equal(seen[0].model, 'small-model');
  assert.equal(seen[0].reasoningEffort, 'low');
  assert.match(seen[0].system, /FORMAT REMINDER/);
  assert.equal(seen[0].purpose, 'auto-review');
  assert.deepEqual(JSON.parse(output.find((chunk) => chunk.type === 'text-delta').text), {
    risk: 'medium',
    decision: 'allow',
  });
});

test('passes the repair stream through when repair is disabled', async () => {
  const { ctx, dispatch } = harness(() =>
    (async function* raw() {
      yield { type: 'text-delta', index: 0, text: 'not json' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })(),
  );
  apply(ctx, { repair: false, provider: 'other', model: 'm' });
  const output = await drain(dispatch(reviewRequest()));
  assert.equal(output[0].text, 'not json');
  assert.deepEqual(output.at(-1).reason, { kind: 'stop' });
});

test('retries an unreadable reply with one correction message', async () => {
  const seen = [];
  let call = 0;
  const { ctx, dispatch } = harness((options) => {
    seen.push(options);
    call += 1;
    return (async function* raw() {
      const chunks = call === 1 ? attempt('I would rather not say.') : attempt('{"risk":"high","decision":"deny"}');
      for (const chunk of chunks) yield chunk;
    })();
  });
  apply(ctx, { retry: 1 });
  const output = await drain(dispatch(reviewRequest()));

  assert.equal(seen.length, 2);
  assert.equal(seen[1].messages.length, seen[0].messages.length + 1);
  assert.match(seen[1].messages.at(-1).content[0].text, /FORMAT CORRECTION/);
  assert.equal(JSON.parse(output.find((chunk) => chunk.type === 'text-delta').text).decision, 'deny');
});
