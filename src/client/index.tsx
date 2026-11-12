/**
 * Settings card for Auto review model selection.
 *
 * It renders inside the Plugins page (`plugins.bundle.config`, keyed by this
 * package's name) and edits the plugin's own volatile config fields through the
 * `configForms` service, so a change takes effect on the next reviewed call
 * without restarting the plugin. The model list comes from the Host model
 * catalog over the `remote.session` gateway; without it the same fields are
 * plain text inputs, and the card still renders.
 *
 * @module dsh-auto-review-model-select/client
 */

import { useEffect, useSyncExternalStore, useState, type CSSProperties, type ReactElement } from 'react';

const NS = 'dsh-auto-review-model-select';
const ENTRY_ID = 'dsh-auto-review-model-select';

/** Copy per built-in locale; untranslated locales fall back to English. */
const en: Record<string, string> = {
  title: 'Auto review',
  intro:
    'The Auto review gate asks one extra model before every tool call. By default it uses the main model and reads a strict JSON answer. These settings pick a dedicated reviewer and repair answers that break the protocol.',
  reviewer: 'Reviewer model',
  followMain: 'Follow the main model',
  provider: 'Provider',
  model: 'Model',
  effort: 'Reasoning effort',
  effortDefault: 'Model default',
  repair: 'Normalize the decision output',
  repairHint: 'Accept prose, code fences, an unexpected reason, or a truncated finish instead of failing the call.',
  hint: 'Append a format reminder',
  hintHint: 'Repeat the JSON contract at the end of the reviewer system prompt.',
  retry: 'Retries',
  retryHint: 'Re-ask the reviewer when its answer cannot be read at all.',
  fallback: 'When no decision can be read',
  fallbackDeny: 'Ask me (recommended)',
  fallbackFail: 'Fail the call',
  fallbackHint:
    '"Ask me" turns the call into a normal approval prompt, so a reviewer slip never blocks work silently.',
  loading: 'Loading configuration…',
  unavailable: 'This entry has no editable configuration in this profile.',
  noCatalog: 'The model catalog is unavailable here, so these are free-text fields.',
  saveFailed: 'The Host did not accept that change.',
  writableHint: 'The current profile layer is read-only, so these values cannot be saved.',
  retryNone: 'No retry',
  retryOnce: '1 retry',
  retryTwice: '2 retries',
  modelPlaceholder: 'model id, for example deepseek-flash',
  providerPlaceholder: 'provider route, for example deepseek-account',
};

const zh: Record<string, string> = {
  title: '自动审查',
  intro:
    '自动审查会在每次工具调用前多问一次模型：默认用主模型，并按严格的 JSON 协议读取回答。这里可以换一个专用审查模型，并把不合规的回答就地修正。',
  reviewer: '审查模型',
  followMain: '跟随主模型',
  provider: '提供方',
  model: '模型',
  effort: '推理强度',
  effortDefault: '模型默认',
  repair: '修正裁决输出',
  repairHint: '容忍前后夹杂的文字、代码围栏、多余的 reason 或被截断的结尾，而不是让调用失败。',
  hint: '追加格式提醒',
  hintHint: '在审查 system prompt 末尾再强调一次 JSON 协议。',
  retry: '重试次数',
  retryHint: '完全读不出裁决时，再问一次审查模型。',
  fallback: '读不出裁决时',
  fallbackDeny: '转人工审批（推荐）',
  fallbackFail: '让调用失败',
  fallbackHint: '“转人工审批”会把这次调用变成普通审批弹窗，审查失误不会静默卡住工作。',
  loading: '正在读取配置…',
  unavailable: '当前 profile 没有这份插件的可编辑配置。',
  noCatalog: '这里拿不到模型目录，下面按文本填写。',
  saveFailed: 'Host 没有接受这次修改。',
  writableHint: '当前 profile 层是只读的，这些值无法保存。',
  retryNone: '不重试',
  retryOnce: '1 次',
  retryTwice: '2 次',
  modelPlaceholder: '模型 id，例如 deepseek-flash',
  providerPlaceholder: '提供方路由，例如 deepseek-account',
};

const DICTS: Record<string, Record<string, string>> = {
  en,
  zh,
  ja: en,
  es: en,
  fr: en,
  de: en,
  ru: en,
  pt: en,
};

/** One model in the Host catalog. */
interface CatalogModel {
  id: string;
  name: string;
  reasoning?: { efforts?: { id: string; name: string }[] };
}

/** One provider group in the Host catalog. */
interface CatalogGroup {
  id: string;
  name: string;
  models: CatalogModel[];
}

/** The Host model catalog payload. */
interface Catalog {
  groups: CatalogGroup[];
}

/** Result envelope every Remote method returns. */
interface CatalogResult {
  ok: boolean;
  value?: Catalog;
  error?: { message?: string };
}

/** A form snapshot for one settings namespace. */
interface FormSnapshot {
  status?: string;
  value?: Record<string, unknown>;
  writable?: boolean;
}

/** The `configForms` entry handle. */
interface FormHandle {
  getSnapshot(): FormSnapshot;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<boolean>;
  dispose(): void | Promise<void>;
}

/** The `remote.session` gateway face this card uses. */
interface RemoteSession {
  modelCatalog(): Promise<CatalogResult>;
}

/** The Client context surface this plugin uses. */
export interface ClientContext {
  get(name: string): unknown;
  effect?(execute: () => void | (() => void), label?: string): void;
  slots: {
    inject(key: string, callback: () => () => void): () => void;
    register(options: { name: string; key: string; locale?: string }, component: unknown): () => void;
  };
  locale: {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void;
    bind(ns: string): (key: string) => string;
  };
}

const palette = {
  label: 'var(--dsw-alias-label-primary)',
  secondary: 'var(--dsw-alias-label-secondary)',
  border: 'var(--dsw-alias-border-l1)',
  field: 'var(--dsw-alias-bg-base)',
  error: 'var(--dsw-alias-state-error-primary)',
};

const style: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 14, color: palette.label, fontSize: 13, lineHeight: 1.5 },
  title: { fontSize: 14, fontWeight: 600, margin: 0 },
  intro: { margin: 0, color: palette.secondary, maxWidth: 720 },
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '12px 14px',
    border: `1px solid ${palette.border}`,
    borderRadius: 10,
  },
  groupTitle: { fontSize: 13, fontWeight: 600, margin: 0 },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(120px, 180px) minmax(0, 1fr)',
    alignItems: 'center',
    columnGap: 12,
    rowGap: 4,
  },
  label: { color: palette.secondary },
  control: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 },
  field: {
    minWidth: 180,
    maxWidth: 360,
    flex: '1 1 180px',
    background: palette.field,
    color: palette.label,
    border: `1px solid ${palette.border}`,
    borderRadius: 6,
    padding: '5px 8px',
    font: 'inherit',
  },
  hint: { color: palette.secondary, margin: 0, gridColumn: '2 / -1' },
  check: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
  error: { color: palette.error, margin: 0 },
  note: { color: palette.secondary, margin: 0 },
};

/** One labeled field row. */
function Row(props: { label: string; hint?: string; children: unknown }): ReactElement {
  return (
    <div style={style.row}>
      <span style={style.label}>{props.label}</span>
      <div style={style.control}>{props.children as never}</div>
      {props.hint === undefined ? null : <p style={style.hint}>{props.hint}</p>}
    </div>
  );
}

/** Props the card receives from the slot plus the bound form and context. */
interface PanelProps {
  view?: 'summary' | 'page';
  t?: (key: string) => string;
  ctx: ClientContext;
  form?: FormHandle;
}

/**
 * Render the settings card.
 * @param props - slot props plus the context and optional form handle.
 * @returns the card, or null in the summary view.
 */
function Panel({ view, t: injected, ctx, form }: PanelProps): ReactElement | null {
  const t = injected ?? ((key: string) => en[key] ?? key);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const snapshot = useSyncExternalStore(
    (listener) => (form === undefined ? () => {} : form.subscribe(listener)),
    () => (form === undefined ? EMPTY_SNAPSHOT : form.getSnapshot()),
  );

  useEffect(() => {
    let alive = true;
    const remote = remoteSession(ctx);
    if (remote === undefined) {
      setCatalogError(t('noCatalog'));
      return () => {
        alive = false;
      };
    }
    remote.modelCatalog().then(
      (result) => {
        if (!alive) return;
        if (result !== null && typeof result === 'object' && result.ok && result.value !== undefined) {
          setCatalog(result.value);
        } else {
          setCatalogError(result?.error?.message ?? t('noCatalog'));
        }
      },
      (error: unknown) => {
        if (alive) setCatalogError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  if (view === 'summary') return null;
  if (form === undefined) return <p style={style.note}>{t('unavailable')}</p>;
  if (snapshot.status === 'loading') return <p style={style.note}>{t('loading')}</p>;
  if (snapshot.status === 'unavailable') return <p style={style.note}>{t('unavailable')}</p>;

  const value = snapshot.value ?? {};
  const writable = snapshot.writable !== false;
  const disabled = !writable || busy;
  const groups = catalog?.groups ?? [];

  const commit = async (field: string, next: unknown): Promise<void> => {
    if (form === undefined) return;
    setBusy(true);
    setFailure(null);
    try {
      const accepted = await form.set(field, next);
      if (accepted !== true) setFailure(t('saveFailed'));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const provider = typeof value.provider === 'string' ? value.provider : '';
  const model = typeof value.model === 'string' ? value.model : '';
  const group = groups.find((candidate) => candidate.id === provider);
  const selectedModel = group?.models.find((candidate) => candidate.id === model);
  const efforts = selectedModel?.reasoning?.efforts ?? [];
  const effort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort : '';

  return (
    <div style={style.root}>
      <h4 style={style.title}>{t('title')}</h4>
      <p style={style.intro}>{t('intro')}</p>
      {writable ? null : <p style={style.note}>{t('writableHint')}</p>}
      {catalogError === null ? null : <p style={style.note}>{catalogError}</p>}

      <div style={style.group}>
        <h5 style={style.groupTitle}>{t('reviewer')}</h5>
        <Row label={t('provider')}>
          {catalog === null ? (
            <TextInput
              value={provider}
              placeholder={t('providerPlaceholder')}
              disabled={disabled}
              onCommit={(next) => commit('provider', next)}
            />
          ) : (
            <select
              style={style.field}
              value={provider}
              disabled={disabled}
              aria-label={t('provider')}
              onChange={(event) => {
                const next = event.target.value;
                void commit('provider', next).then(() => {
                  const nextGroup = groups.find((candidate) => candidate.id === next);
                  if (next !== '' && !(nextGroup?.models.some((candidate) => candidate.id === model) ?? false)) {
                    void commit('model', '');
                  }
                });
              }}
            >
              <option value="">{t('followMain')}</option>
              {groups.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name || candidate.id}
                </option>
              ))}
              {provider !== '' && group === undefined ? <option value={provider}>{provider}</option> : null}
            </select>
          )}
        </Row>

        <Row label={t('model')}>
          {catalog === null ? (
            <TextInput
              value={model}
              placeholder={t('modelPlaceholder')}
              disabled={disabled || provider === ''}
              onCommit={(next) => commit('model', next)}
            />
          ) : (
            <select
              style={style.field}
              value={provider === '' ? '' : model}
              disabled={disabled || provider === ''}
              aria-label={t('model')}
              onChange={(event) => void commit('model', event.target.value)}
            >
              <option value="">{t('followMain')}</option>
              {(group?.models ?? []).map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name || candidate.id}
                </option>
              ))}
              {model !== '' && selectedModel === undefined ? <option value={model}>{model}</option> : null}
            </select>
          )}
        </Row>

        {efforts.length === 0 ? null : (
          <Row label={t('effort')}>
            <select
              style={style.field}
              value={effort}
              disabled={disabled}
              aria-label={t('effort')}
              onChange={(event) => void commit('reasoningEffort', event.target.value)}
            >
              <option value="">{t('effortDefault')}</option>
              {efforts.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name || candidate.id}
                </option>
              ))}
            </select>
          </Row>
        )}
      </div>

      <div style={style.group}>
        <h5 style={style.groupTitle}>{t('repair')}</h5>
        <Row label={t('repair')} hint={t('repairHint')}>
          <label style={style.check}>
            <input
              type="checkbox"
              checked={value.repair !== false}
              disabled={disabled}
              onChange={(event) => void commit('repair', event.target.checked)}
            />
            <span>{t('repair')}</span>
          </label>
        </Row>
        <Row label={t('hint')} hint={t('hintHint')}>
          <label style={style.check}>
            <input
              type="checkbox"
              checked={value.hint !== false}
              disabled={disabled}
              onChange={(event) => void commit('hint', event.target.checked)}
            />
            <span>{t('hint')}</span>
          </label>
        </Row>
        <Row label={t('retry')} hint={t('retryHint')}>
          <select
            style={style.field}
            value={String(typeof value.retry === 'number' ? value.retry : 1)}
            disabled={disabled}
            aria-label={t('retry')}
            onChange={(event) => void commit('retry', Number(event.target.value))}
          >
            <option value="0">{t('retryNone')}</option>
            <option value="1">{t('retryOnce')}</option>
            <option value="2">{t('retryTwice')}</option>
          </select>
        </Row>
        <Row label={t('fallback')} hint={t('fallbackHint')}>
          <select
            style={style.field}
            value={value.fallback === 'fail' ? 'fail' : 'deny'}
            disabled={disabled}
            aria-label={t('fallback')}
            onChange={(event) => void commit('fallback', event.target.value)}
          >
            <option value="deny">{t('fallbackDeny')}</option>
            <option value="fail">{t('fallbackFail')}</option>
          </select>
        </Row>
      </div>

      {failure === null ? null : (
        <p style={style.error} role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}

const EMPTY_SNAPSHOT: FormSnapshot = { status: 'unavailable' };

/** Resolve the `remote.session` gateway lazily, tolerating either service shape. */
function remoteSession(ctx: ClientContext): RemoteSession | undefined {
  for (const name of ['remote.session', 'remote']) {
    let candidate: unknown;
    try {
      candidate = ctx.get(name);
    } catch {
      candidate = undefined;
    }
    if (candidate === undefined || candidate === null) continue;
    const session = (candidate as { session?: unknown }).session ?? candidate;
    if (typeof (session as RemoteSession | undefined)?.modelCatalog === 'function') {
      return session as RemoteSession;
    }
  }
  return undefined;
}

/** A text field that commits on blur or Enter, not on every keystroke. */
function TextInput(props: {
  value: string;
  placeholder: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = (): void => {
    if (draft !== props.value) props.onCommit(draft);
  };
  return (
    <input
      style={style.field}
      type="text"
      value={draft}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

/** Register the card when the plugin loads. */
export const inject = ['slots', 'locale'] as const;

/**
 * Install the settings card.
 * @param ctx - the Client plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Localization is a convenience: a refusal here must never cost the card.
  try {
    ctx.locale.register(NS, DICTS);
  } catch (error) {
    console.warn('[dsh-auto-review-model-select] locale registration failed', error);
  }
  let fallback: (key: string) => string = (key) => en[key] ?? key;
  try {
    fallback = ctx.locale.bind(NS);
  } catch (error) {
    console.warn('[dsh-auto-review-model-select] locale bind failed', error);
  }

  let cached: FormHandle | undefined;

  /** Resolve the entry's form once the settings service and namespace exist. */
  const form = (): FormHandle | undefined => {
    if (cached !== undefined) return cached;
    let service: unknown;
    try {
      service = ctx.get('configForms');
    } catch {
      service = undefined;
    }
    const get = (service as { get?: (id: string) => FormHandle } | undefined)?.get;
    if (typeof get !== 'function') return undefined;
    try {
      cached = get.call(service, ENTRY_ID);
      return cached;
    } catch {
      return undefined;
    }
  };

  ctx.effect?.(
    () => () => {
      void cached?.dispose();
      cached = undefined;
    },
    'auto-review-model-select: settings form',
  );

  const Card = (props: { view?: 'summary' | 'page'; t?: (key: string) => string }): ReactElement | null => (
    <Panel view={props.view} t={props.t ?? fallback} ctx={ctx} form={form()} />
  );

  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      { name: 'plugins.bundle.config', key: ENTRY_ID, locale: NS },
      Card,
    ),
  );
}
