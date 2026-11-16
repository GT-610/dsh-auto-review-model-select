/**
 * Guard the plugin-card locale files.
 *
 * The UI dictionaries in `src/client/index.tsx` are kept in step by a test, but
 * `locale/*.json` is plain JSON that nothing else reads: it is the card a
 * marketplace renders for this bundle. A malformed or half-translated card would
 * ship without a single other check noticing.
 *
 * Usage: `node scripts/check-locale.mjs`
 */
import { readFile } from 'node:fs/promises'

/** Locale files that must agree, in the order they are reported. */
const LOCALES = ['en', 'zh']

/**
 * Read and parse one locale file.
 * @param locale - locale code, which is also the file stem.
 * @returns the parsed card.
 */
async function load(locale) {
  return JSON.parse(await readFile(`locale/${locale}.json`, 'utf8'))
}

/** The `meta` key names of one card, sorted, so two cards can be compared. */
function shape(card) {
  return Object.keys(card.meta ?? {}).toSorted().join(',')
}

const loaded = await Promise.all(LOCALES.map(async locale => [locale, await load(locale)]))
const expected = shape(loaded[0][1])

for (const [locale, card] of loaded) {
  if (typeof card.meta?.title !== 'string' || typeof card.meta?.description !== 'string') {
    console.error(`locale/${locale}.json needs a string meta.title and a string meta.description`)
    process.exit(1)
  }
  if (shape(card) !== expected) {
    console.error(`locale/${locale}.json declares meta keys [${shape(card)}], expected [${expected}]`)
    process.exit(1)
  }
}

console.log(`locale cards agree: ${LOCALES.join(', ')}`)
