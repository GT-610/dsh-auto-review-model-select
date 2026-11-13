import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import React from 'react';
import jsxRuntime from 'react/jsx-runtime';
import renderer from 'react-test-renderer';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, create } = renderer;

/** The shipped client artifact the web shell loads. */
const source = readFileSync(new URL('../dist/client.cjs', import.meta.url), 'utf8');

/** Load the bundle and return the plugin definition it registers. */
function loadPlugin() {
  let entry;
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load: (value) => {
          entry = value;
        },
      },
    },
    console,
    URL,
  });
  assert.ok(entry, 'the bundle must register itself with the module loader');
  assert.equal(entry.id, 'dsh-auto-review-model-select');
  return entry.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return jsxRuntime;
    throw new Error(`unexpected require: ${name}`);
  });
}

/** One form snapshot shaped like `ConfigFormController.getSnapshot()`. */
function snapshot(value = {}, { writable = true, status = 'ready' } = {}) {
  return { status, value, writable };
}

/**
 * Build the Client context and record what the plugin does with it.
 * @param options - snapshot overrides, catalog Remote, and write acceptance.
 */
function harness(options = {}) {
  const { value = {}, writable = true, status = 'ready', remote, accept } = options;
  const records = [];
  const sets = [];
  const registered = [];
  let localeDicts;
  const store = snapshot(value, { writable, status });

  const form = {
    getSnapshot: () => store,
    subscribe: () => () => {},
    set: async (field, next) => {
      sets.push([field, next]);
      return accept === undefined ? true : accept(field, next);
    },
    dispose: async () => {},
  };

  const ctx = {
    get(name) {
      if (name === 'configForms') {
        return {
          get: (id) => {
            records.push(['form', id]);
            return form;
          },
        };
      }
      if (name === 'remote.session') return remote;
      return undefined;
    },
    effect(execute) {
      const cleanup = execute();
      return typeof cleanup === 'function' ? cleanup : () => {};
    },
    locale: {
      register(ns, dicts) {
        localeDicts = dicts;
        records.push(['locale', ns]);
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
      register(options_, component) {
        records.push(['register', options_.name, options_.key, options_.locale]);
        registered.push(component);
        return () => {};
      },
    },
  };

  return { ctx, records, sets, registered, dicts: () => localeDicts };
}

/** Mount the registered card with an identity-plus translator. */
async function mount(plugin, box) {
  plugin.apply(box.ctx);
  return renderCard(box.registered[0]);
}

/** Render one already-registered card. */
async function renderCard(Card) {
  assert.equal(typeof Card, 'function');
  let tree;
  await act(async () => {
    tree = create(React.createElement(Card, { t: (key) => `t:${key}` }));
  });
  return tree;
}

/** Flatten every text node in a rendered tree. */
function textOf(json) {
  if (json === null || json === undefined || json === false) return '';
  if (typeof json === 'string' || typeof json === 'number') return String(json);
  if (Array.isArray(json)) return json.map((item) => textOf(item)).join('');
  return textOf(json.children);
}

/** All rendered nodes matching a predicate. */
function findAll(tree, predicate) {
  return tree.root.findAll(predicate);
}

/** The one `<select>` labelled with a translator key, if any. */
function selectByLabel(tree, label) {
  return findAll(tree, (node) => node.type === 'select' && node.props['aria-label'] === label)[0];
}

/** Every rendered `<input>` of one type, in tree order. */
function inputsOfType(tree, type) {
  return findAll(tree, (node) => node.type === 'input' && node.props.type === type);
}

test('registers the card under the bundle name with its services', async () => {
  const plugin = loadPlugin();
  assert.ok(Array.isArray(plugin.inject));
  assert.deepEqual([...plugin.inject], ['slots', 'locale', 'configForms', 'remote']);

  const box = harness();
  plugin.apply(box.ctx);

  assert.deepEqual(recordsOf(box, 'inject'), [['inject', 'plugins.bundle.config']]);
  assert.deepEqual(recordsOf(box, 'register'), [
    ['register', 'plugins.bundle.config', 'dsh-auto-review-model-select', 'dsh-auto-review-model-select'],
  ]);

  await renderCard(box.registered[0]);
  assert.deepEqual(recordsOf(box, 'form'), [['form', 'dsh-auto-review-model-select']]);

  const dicts = box.dicts();
  assert.deepEqual(Object.keys(dicts).sort(), ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh']);
  assert.deepEqual(Object.keys(dicts.en).sort(), Object.keys(dicts.zh).sort(), 'every locale defines the same copy');
});

test('renders values from the configuration snapshot', async () => {
  const plugin = loadPlugin();
  const box = harness({
    value: {
      enabled: false,
      provider: 'main-provider',
      model: 'main-model',
      repair: false,
      hint: true,
      retry: 2,
      fallback: 'fail',
    },
  });
  const tree = await mount(plugin, box);

  assert.match(textOf(tree.toJSON()), /t:intro/);
  const [provider, model] = inputsOfType(tree, 'text');
  assert.equal(provider.props.value, 'main-provider');
  assert.equal(model.props.value, 'main-model');
  const checkboxes = inputsOfType(tree, 'checkbox');
  assert.equal(checkboxes[0].props.checked, false, 'the plugin is switched off');
  assert.equal(checkboxes[1].props.checked, false, 'repair is off');
  assert.equal(checkboxes[2].props.checked, true, 'hint is on');
  assert.equal(selectByLabel(tree, 't:retry').props.value, '2');
  assert.equal(selectByLabel(tree, 't:fallback').props.value, 'fail');
});

test('loads the model catalog and offers provider and model selects', async () => {
  const plugin = loadPlugin();
  const box = harness({
    remote: {
      modelCatalog: async () => ({
        ok: true,
        value: {
          groups: [
            {
              id: 'prov-a',
              name: 'Provider A',
              models: [{ id: 'model-a', name: 'Model A', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }],
            },
          ],
        },
      }),
    },
  });
  const tree = await mount(plugin, box);

  const provider = selectByLabel(tree, 't:provider');
  assert.ok(provider, 'the provider becomes a select when the catalog is available');
  assert.deepEqual(
    provider.findAll((node) => node.type === 'option').map((node) => node.props.value),
    ['', 'prov-a'],
  );
  const model = selectByLabel(tree, 't:model');
  assert.deepEqual(
    model.findAll((node) => node.type === 'option').map((node) => node.props.value),
    [''],
    'no model is offered until a provider is chosen',
  );
});

test('saves a field through the form and surfaces a refusal', async () => {
  const plugin = loadPlugin();
  const box = harness({ accept: () => false });
  const tree = await mount(plugin, box);

  const checkboxes = inputsOfType(tree, 'checkbox');
  await act(async () => {
    checkboxes[1].props.onChange({ target: { checked: false } });
  });

  assert.deepEqual(box.sets, [['repair', false]]);
  assert.match(textOf(tree.toJSON()), /t:saveFailed/);
});

test('keeps the model when the provider write is refused', async () => {
  const plugin = loadPlugin();
  const box = harness({
    value: { provider: 'prov-a', model: 'model-a' },
    accept: (field) => field !== 'provider',
    remote: {
      modelCatalog: async () => ({
        ok: true,
        value: {
          groups: [
            { id: 'prov-a', name: 'A', models: [{ id: 'model-a', name: 'MA' }] },
            { id: 'prov-b', name: 'B', models: [{ id: 'model-b', name: 'MB' }] },
          ],
        },
      }),
    },
  });
  const tree = await mount(plugin, box);

  await act(async () => {
    selectByLabel(tree, 't:provider').props.onChange({ target: { value: 'prov-b' } });
  });

  assert.deepEqual(box.sets, [['provider', 'prov-b']], 'the refused write must not clear the model');
});

test('clears the model when the new provider does not serve it', async () => {
  const plugin = loadPlugin();
  const box = harness({
    value: { provider: 'prov-a', model: 'model-a' },
    remote: {
      modelCatalog: async () => ({
        ok: true,
        value: {
          groups: [
            { id: 'prov-a', name: 'A', models: [{ id: 'model-a', name: 'MA' }] },
            { id: 'prov-b', name: 'B', models: [{ id: 'model-b', name: 'MB' }] },
          ],
        },
      }),
    },
  });
  const tree = await mount(plugin, box);

  await act(async () => {
    selectByLabel(tree, 't:provider').props.onChange({ target: { value: 'prov-b' } });
  });

  assert.deepEqual(box.sets, [
    ['provider', 'prov-b'],
    ['model', ''],
  ]);
});

test('reloads the catalog after a failed read', async () => {
  const plugin = loadPlugin();
  let calls = 0;
  const box = harness({
    remote: {
      modelCatalog: async () => {
        calls += 1;
        if (calls === 1) throw new Error('host not ready');
        return { ok: true, value: { groups: [{ id: 'prov-a', name: 'A', models: [] }] } };
      },
    },
  });
  const tree = await mount(plugin, box);

  assert.match(textOf(tree.toJSON()), /host not ready/);
  assert.equal(selectByLabel(tree, 't:provider'), undefined, 'no catalog means free-text fields');

  const reload = findAll(tree, (node) => node.type === 'button' && node.props.children === 't:reloadCatalog')[0];
  assert.ok(reload, 'the failure offers a reload action');
  await act(async () => {
    reload.props.onClick();
  });

  assert.equal(calls, 2);
  assert.ok(selectByLabel(tree, 't:provider'), 'the second read switches to selects');
});

/** The record rows of one kind. */
function recordsOf(box, kind) {
  return box.records.filter((entry) => entry[0] === kind);
}
