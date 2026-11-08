// Offline tests for the browser half.
//
// The bundle registers a factory with window.__ModuleLoader__; this harness
// captures that registration and runs the factory with a stub React module and
// no DOM. Only the pure helpers the bundle exposes through the test seam are
// exercised — the page itself never enables that seam.
import assert from 'node:assert/strict'
import { test } from 'node:test'

let entry = null
const storage = new Map()
globalThis.window = {
  __BETTER_MARKDOWN_TEST__: true,
  __ModuleLoader__: { load: next => { entry = next } },
  localStorage: {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
  },
}

const reactStub = {
  createElement: () => null,
  useMemo: fn => fn(),
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useState: () => [null, () => {}],
}

await import('../client.js')
assert.ok(entry !== null, 'the bundle did not register with the module loader')
const bundle = entry.factory((id) => {
  if (id === 'react') return reactStub
  if (id === '@deepseek-ai/dsh-client-ui-primitives') throw new Error('primitives are not a test dependency')
  throw new Error(`unexpected require: ${id}`)
})
const helpers = bundle.__test
assert.ok(helpers !== undefined, 'test helpers missing (window.__BETTER_MARKDOWN_TEST__ not applied)')
assert.equal(typeof bundle.apply, 'function')
assert.deepEqual(bundle.inject, ['slots', 'locale'])

const {
  DEFAULT_CONFIG, HIGHLIGHT_NAMES, looksLikeMarkdown, applyHardBreaks,
  markdownHighlightSpans, normalizeConfig, createStore, readPrefs, writePrefs,
} = helpers

const sample = [
  '# 标题',
  '',
  '这是 **加粗** 和 *斜体* 以及 `code`，还有 [链接](https://example.com)。',
  '',
  '- 项目一',
  '- 项目二',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '> 引用 **重点**',
].join('\n')

/** Substrings covered by every span of one highlight name. */
const spansNamed = (name) => markdownHighlightSpans(sample)
  .filter(span => span.name === name)
  .map(span => sample.slice(span.start, span.end))

test('syntax detection ignores plain prose and finds real Markdown', () => {
  assert.equal(looksLikeMarkdown(''), false)
  assert.equal(looksLikeMarkdown('你好，世界。\n第二行而已'), false)
  assert.equal(looksLikeMarkdown('2 * 3 = 6'), false)
  assert.equal(looksLikeMarkdown('file_name stays plain'), false)
  assert.equal(looksLikeMarkdown('**bold**'), true)
  assert.equal(looksLikeMarkdown('# heading'), true)
  assert.equal(looksLikeMarkdown('- item'), true)
  assert.equal(looksLikeMarkdown('') || looksLikeMarkdown(sample), true)
})

test('hard breaks preserve chat line breaks outside code and tables', () => {
  const twoLines = applyHardBreaks('line one\nline two')
  assert.equal(twoLines, 'line one  \nline two')

  const fenced = '```\ncode one\ncode two\n```'
  assert.equal(applyHardBreaks(fenced), fenced)

  const table = '| a | b |\n|---|---|\n| 1 | 2 |'
  assert.equal(applyHardBreaks(table), table)

  const already = 'line one  \nline two'
  assert.equal(applyHardBreaks(already), already)

  const indented = 'para\n\n    indented code\n    next'
  assert.equal(applyHardBreaks(indented), 'para\n\n    indented code\n    next')

  assert.equal(applyHardBreaks('single line'), 'single line')
})

test('headings, emphasis, code and links split markers from content', () => {
  assert.deepEqual(spansNamed('bm-heading'), ['标题'])
  assert.deepEqual(spansNamed('bm-strong'), ['加粗', '重点'])
  assert.deepEqual(spansNamed('bm-em'), ['斜体'])
  assert.deepEqual(spansNamed('bm-code'), ['code'])
  assert.deepEqual(spansNamed('bm-link'), ['链接'])
  assert.deepEqual(spansNamed('bm-quote'), ['引用 **重点**'])
  assert.deepEqual(spansNamed('bm-fence'), ['const a = 1'])
  assert.deepEqual(spansNamed('bm-list'), ['-', '-'])
  assert.equal(HIGHLIGHT_NAMES.includes('bm-mark'), true)
})

test('every span stays inside the source and is nonempty', () => {
  for (const span of markdownHighlightSpans(sample)) {
    assert.ok(span.start >= 0 && span.end <= sample.length, 'span out of range')
    assert.ok(span.end > span.start, 'empty span')
    assert.ok(HIGHLIGHT_NAMES.includes(span.name), `unknown highlight name ${span.name}`)
  }
  assert.deepEqual(markdownHighlightSpans(''), [])
})

test('a lone asterisk or underscore is not emphasis', () => {
  const spans = markdownHighlightSpans('a * b and snake_case_name')
  assert.deepEqual(spans.filter(span => span.name === 'bm-em'), [])
})

test('config normalization mirrors the host defaults', () => {
  assert.deepEqual(normalizeConfig(undefined), { ...DEFAULT_CONFIG })
  assert.deepEqual(normalizeConfig({ preview: false, composer: 'no', transcript: null }), {
    ...DEFAULT_CONFIG,
    preview: false,
  })
})

test('the store notifies only on a changed snapshot', () => {
  const store = createStore({ n: 1 })
  let calls = 0
  const off = store.subscribe(() => { calls += 1 })
  store.set(store.getSnapshot())
  assert.equal(calls, 0)
  store.set({ n: 2 })
  assert.equal(calls, 1)
  off()
  store.set({ n: 3 })
  assert.equal(calls, 1)
})

test('the preview preference round-trips through localStorage', () => {
  storage.clear()
  assert.deepEqual(readPrefs(), { preview: null })
  writePrefs({ preview: false })
  assert.deepEqual(readPrefs(), { preview: false })
  storage.set('better-markdown.prefs.v1', '{broken')
  assert.deepEqual(readPrefs(), { preview: null })
  storage.set('better-markdown.prefs.v1', '{"preview":"yes"}')
  assert.deepEqual(readPrefs(), { preview: null })
})
