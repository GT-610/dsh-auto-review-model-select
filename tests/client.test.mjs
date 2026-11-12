import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/** The shipped client artifact the web shell loads. */
const source = readFileSync(new URL('../dist/client.cjs', import.meta.url), 'utf8');

/** Minimal React face: the bundle only defines components at load time. */
const reactStub = {
  createElement: () => null,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useSyncExternalStore: () => ({ status: 'ready', value: {}, writable: true }),
};

/** Minimal JSX runtime; the tree is never rendered in this test. */
const jsxStub = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' };

/** Load the bundle and return the plugin definition it registers. */
function loadPlugin() {
  let entry;
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: (value) => { entry = value; } } },
    console,
    URL,
  });
  assert.ok(entry, 'the bundle must register itself with the module loader');
  assert.equal(entry.id, 'dsh-auto-review-model-select');
  return entry.factory((name) => {
    if (name === 'react') return reactStub;
    if (name === 'react/jsx-runtime') return jsxStub;
    throw new Error(`unexpected require: ${name}`);
  });
}

/** A Client context recording what the plugin registers. */
function harness() {
  const records = [];
  const registered = [];
  const form = {
    getSnapshot: () => ({ status: 'ready', value: { provider: '', model: '', retry: 1, fallback: 'deny' }, writable: true }),
    subscribe: () => () => {},
    set: async () => true,
    dispose: () => {},
  };
  const ctx = {
    get(name) {
      if (name === 'configForms') return { get: (id) => { records.push(['form', id]); return form; } };
      return undefined;
    },
    effect(execute) {
      const cleanup = execute();
      records.push(['effect', typeof cleanup]);
    },
    locale: {
      register(ns, dicts) {
        records.push(['locale', ns, Object.keys(dicts).sort().join('|')]);
        return () => {};
      },
      bind: () => (key) => key,
    },
    slots: {
      inject(key, callback) {
        records.push(['inject', key]);
        callback();
        return () => {};
      },
      register(options, component) {
        records.push(['register', options.name, options.key, options.locale, typeof component]);
        registered.push(component);
        return () => {};
      },
    },
  };
  return { ctx, records, form, registered };
}

test('registers the config card under the bundle name', () => {
  const plugin = loadPlugin();
  assert.ok(Array.isArray(plugin.inject));
  assert.equal(typeof plugin.apply, 'function');

  const { ctx, records } = harness();
  plugin.apply(ctx);

  assert.deepEqual(records.find((entry) => entry[0] === 'inject'), ['inject', 'plugins.bundle.config']);
  assert.deepEqual(records.find((entry) => entry[0] === 'register'), [
    'register',
    'plugins.bundle.config',
    'dsh-auto-review-model-select',
    'dsh-auto-review-model-select',
    'function',
  ]);
  assert.deepEqual(records.find((entry) => entry[0] === 'locale'), [
    'locale',
    'dsh-auto-review-model-select',
    'de|en|es|fr|ja|pt|ru|zh',
  ]);
});

test('renders the page view and skips the summary view', () => {
  const plugin = loadPlugin();
  const { ctx, registered, records } = harness();
  plugin.apply(ctx);
  const Card = registered[0];
  assert.equal(typeof Card, 'function');
  assert.doesNotThrow(() => Card({ view: 'page' }));
  assert.deepEqual(records.find((entry) => entry[0] === 'form'), ['form', 'dsh-auto-review-model-select']);
  assert.equal(Card({ view: 'summary' }), null);
});
