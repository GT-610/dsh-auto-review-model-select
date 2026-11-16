/**
 * Pure-failure guard for the client bundle.
 *
 * A client bundle runs inside the shell's frozen module table, which seeds only
 * the baseline modules. A `require` of anything else is not a build error: the
 * bundler either inlines the dependency (bloating the artifact and duplicating a
 * copy of a package the shell already owns) or leaves the request in place,
 * where it fails at runtime with a module the table cannot resolve.
 *
 * Nothing else in CI would notice, because `tsc`, `oxlint` and the tests all run
 * against sources rather than the emitted artifact. This script reads the
 * artifact and refuses a request outside the baseline.
 *
 * Usage: `node scripts/check-client-purity.mjs [bundle]`
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * The modules the web shell seeds into `window.__ModuleLoader__`. Derived from
 * the `require` calls of the shipped `dsh-client-*` bundles in DSH 0.2.2-rc.3.
 * Keep this list identical to `PLATFORM_MODULES` in `tsdown.config.ts`, which is
 * what keeps these packages out of the bundle in the first place.
 */
const BASELINE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const bundle = resolve(process.argv[2] ?? 'dist/client.cjs')
const source = await readFile(bundle, 'utf8')

/**
 * The two lists live in different files and must not drift: `tsdown.config.ts`
 * keeps these packages out of the artifact, and `BASELINE` above decides what
 * the artifact may request. A module added to one alone either bloats the
 * bundle or makes this guard reject a legitimate request.
 */
const configSource = await readFile(resolve('tsdown.config.ts'), 'utf8')
const declared = configSource.match(/const PLATFORM_MODULES = \[([\s\S]*?)\]/)?.[1]

if (declared === undefined) {
  console.error('could not read PLATFORM_MODULES from tsdown.config.ts')
  process.exit(1)
}

const fromConfig = [...declared.matchAll(/'([^']+)'/g)].map(match => match[1])

if (fromConfig.join(',') !== BASELINE.join(',')) {
  console.error(
    'PLATFORM_MODULES in tsdown.config.ts and BASELINE here disagree:\n'
    + `  tsdown.config.ts: ${fromConfig.join(', ')}\n`
    + `  BASELINE:         ${BASELINE.join(', ')}`,
  )
  process.exit(1)
}

/** Every module specifier the emitted factory asks the module table for. */
const requested = new Set(
  [...source.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map(match => match[1]),
)

const unknown = [...requested].filter(specifier => !BASELINE.includes(specifier)).toSorted()

if (unknown.length > 0) {
  console.error(
    `client bundle requests ${unknown.length} module(s) outside the baseline:\n`
    + unknown.map(specifier => `  - ${specifier}`).join('\n')
    + '\n\nEither import the package as `import type` only, or add it to both'
    + ' PLATFORM_MODULES in tsdown.config.ts and BASELINE here (which requires'
    + ' the shell to seed it).',
  )
  process.exit(1)
}

console.log(`client bundle is pure: ${[...requested].toSorted().join(', ')}`)
