#!/usr/bin/env node
/**
 * Live verification for the Better Markdown plugin against a dev `dsh web`
 * instance. Boots nothing itself: expects /tmp/dsh-bm.log to carry the
 * tokenized URL of a running instance whose profile links this checkout.
 *
 * Checks:
 *   1. the plugin mounted (root attribute, toolbar switch, no console errors)
 *   2. a typed draft shows the rendered preview with real Markdown elements
 *   3. the draft itself is syntax-highlighted with the CSS Custom Highlight API
 *   4. the switch hides and restores the preview and persists the choice
 *   5. a sent message renders Markdown in the durable transcript bubble
 *
 * Screenshots land under docs/.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureBrowser } from './cdp.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const log = readFileSync('/tmp/dsh-bm.log', 'utf8')
const url = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)?.[0]
if (!url) throw new Error('no dev URL in /tmp/dsh-bm.log')
const urlPort = new URL(url).port
if (urlPort === '62184') throw new Error('refusing to drive the desktop app session port')

const MARKDOWN = [
  '# 发布计划',
  '',
  '这是 **加粗**、*斜体*、`inline code`，还有 [链接](https://example.com)。',
  '',
  '- 第一项',
  '- 第二项',
  '',
  '```js',
  'const answer = 42',
  '```',
].join('\n')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await ensureBrowser()
const page = await browser.createPage({ url, width: 1440, height: 1000 })
try {
  await page.waitFor('document.documentElement.getAttribute("data-dsh-better-markdown") === "on"', {
    timeout: 15_000, label: 'plugin mount',
  })
  await page.eval('new Promise(r => setTimeout(r, 600)).then(() => true)')

  // A clean session keeps the evidence screenshots free of older turns.
  await page.click('[class*="newSession"]')
  await page.eval('new Promise(r => setTimeout(r, 900)).then(() => true)')
  await page.dismissPreviewNotice({ timeout: 1_500 })
  const fresh = await page.eval(`(() => ({
    editable: document.querySelector('[data-composer-input]')?.getAttribute('contenteditable'),
    draft: document.querySelector('[data-composer-input]')?.textContent ?? null,
  }))()`)
  check('a fresh session starts with an empty editable composer', fresh.editable === 'true' && fresh.draft === '',
    JSON.stringify(fresh))

  // 1. Mounted.
  const mounted = await page.eval(`(() => ({
    toggle: !!document.querySelector('.bm-toggle'),
    toggleActive: document.querySelector('.bm-toggle')?.getAttribute('data-active'),
    highlightApi: typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function',
  }))()`)
  check('plugin mounted with its toolbar switch', mounted.toggle)
  check('CSS Custom Highlight API available', mounted.highlightApi)
  check('switch defaults to pressed', mounted.toggleActive === 'on', String(mounted.toggleActive))

  // 2. Clear the persisted draft with a real click + Select All + Backspace,
  // then type the Markdown sample.
  const caret = await page.eval(`(() => {
    const el = document.querySelector('[data-composer-input]')
    el.scrollIntoView({ block: 'center' })
    const rect = el.getBoundingClientRect()
    return { x: rect.left + 10, y: rect.top + 12 }
  })()`)
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: caret.x, y: caret.y, button: 'left', buttons: 1, clickCount: 1 })
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: caret.x, y: caret.y, button: 'left', buttons: 0, clickCount: 1 })
  await page.eval('new Promise(r => setTimeout(r, 150)).then(() => true)')
  await page.press('a', { modifiers: 4 })
  await page.press('Backspace')
  await page.eval('new Promise(r => setTimeout(r, 250)).then(() => true)')
  const clearedDraft = await page.eval('document.querySelector("[data-composer-input]").textContent')
  check('composer draft cleared for the scenario', clearedDraft === '', JSON.stringify(clearedDraft))
  await page.type('[data-composer-input]', MARKDOWN)
  await page.eval('new Promise(r => setTimeout(r, 800)).then(() => true)')

  const composed = await page.eval(`(() => {
    const preview = document.querySelector('[data-bm-preview]')
    const body = preview?.querySelector('.bm-md')
    const highlights = typeof CSS !== 'undefined' && CSS.highlights ? [...CSS.highlights.keys()] : []
    return {
      draft: document.querySelector('[data-composer-input]')?.textContent ?? '',
      preview: !!preview,
      strong: body?.querySelectorAll('strong').length ?? 0,
      em: body?.querySelectorAll('em').length ?? 0,
      h1: body?.querySelector('h1')?.textContent ?? null,
      li: body?.querySelectorAll('li').length ?? 0,
      pre: body?.querySelectorAll('pre').length ?? 0,
      inlineCode: body?.querySelectorAll('code').length ?? 0,
      highlights,
      sizes: Object.fromEntries(highlights.map(name => [name, CSS.highlights.get(name)?.size ?? 0])),
    }
  })()`)

  check('draft keeps the exact Markdown source', composed.draft === MARKDOWN)
  check('preview appears for a Markdown draft', composed.preview)
  check('preview renders heading', composed.h1 === '发布计划', String(composed.h1))
  check('preview renders bold/italic/inline code', composed.strong === 1 && composed.em === 1 && composed.inlineCode >= 1,
    `strong=${composed.strong} em=${composed.em} code=${composed.inlineCode}`)
  check('preview renders list and fenced block', composed.li === 2 && composed.pre === 1,
    `li=${composed.li} pre=${composed.pre}`)
  const expectedHighlights = ['bm-mark', 'bm-strong', 'bm-em', 'bm-code', 'bm-heading', 'bm-list', 'bm-fence']
  const missing = expectedHighlights.filter(name => !composed.highlights.includes(name))
  check('composer draft is syntax-highlighted in place', missing.length === 0,
    missing.length === 0 ? composed.highlights.join(', ') : `missing ${missing.join(', ')}`)
  check('highlight ranges are nonempty',
    Object.values(composed.sizes).every(size => size > 0), JSON.stringify(composed.sizes))

  // Composer screenshot: scroll the composer into view.
  await page.eval(`(() => { document.querySelector('[data-composer-card]').scrollIntoView({ block: 'center' }); return true })()`)
  await page.eval('new Promise(r => setTimeout(r, 300)).then(() => true)')
  await page.screenshot(resolve(ROOT, 'docs/preview.png'))

  // 3. The switch hides and restores the preview.
  await page.click('.bm-toggle')
  await page.eval('new Promise(r => setTimeout(r, 400)).then(() => true)')
  const hidden = await page.eval('!!document.querySelector("[data-bm-preview]")')
  const storedOff = await page.eval('localStorage.getItem("better-markdown.prefs.v1")')
  check('switch hides the preview', hidden === false)
  check('switch persists the browser override', storedOff === '{"preview":false}', String(storedOff))
  await page.click('.bm-toggle')
  await page.eval('new Promise(r => setTimeout(r, 400)).then(() => true)')
  const restored = await page.eval('!!document.querySelector("[data-bm-preview]")')
  check('switch restores the preview', restored === true)

  // 4. Send and verify the durable transcript bubble.
  await page.press('Enter')
  await page.eval('new Promise(r => setTimeout(r, 2500)).then(() => true)')
  const transcript = await page.eval(`(() => {
    const bubble = document.querySelector('[data-message-bubble] [data-bm-markdown]')
    return {
      markdownBubble: !!bubble,
      h1: bubble?.querySelector('h1')?.textContent ?? null,
      strong: bubble?.querySelectorAll('strong').length ?? 0,
      li: bubble?.querySelectorAll('li').length ?? 0,
      pre: bubble?.querySelectorAll('pre').length ?? 0,
      text: bubble?.textContent?.slice(0, 80) ?? null,
    }
  })()`)
  check('sent user message renders as Markdown', transcript.markdownBubble)
  check('transcript heading survives', transcript.h1 === '发布计划', String(transcript.h1))
  check('transcript keeps emphasis, list and code block',
    transcript.strong === 1 && transcript.li === 2 && transcript.pre === 1,
    `strong=${transcript.strong} li=${transcript.li} pre=${transcript.pre}`)

  await page.eval(`(() => { document.querySelector('[data-message-bubble]').scrollIntoView({ block: 'center' }); return true })()`)
  await page.eval('new Promise(r => setTimeout(r, 350)).then(() => true)')
  const bubbleClip = await page.eval(`(() => {
    const rect = document.querySelector('[data-message-bubble]').getBoundingClientRect()
    const x = Math.max(4, rect.left - 24)
    const y = Math.max(4, rect.top - 24)
    return {
      x,
      y,
      width: Math.min(innerWidth - x - 4, rect.width + 48),
      height: Math.min(innerHeight - y - 4, rect.height + 48),
    }
  })()`)
  await page.screenshot(resolve(ROOT, 'docs/transcript.png'), { clip: { ...bubbleClip, scale: 2 } })

  const errors = page.consoleMessages.filter(message => message.type === 'error' && !/no API key|MISSING_CREDENTIAL|本轮运行失败/.test(message.text))
  check('no plugin console errors', errors.length === 0, errors.slice(0, 3).map(e => e.text).join(' | '))
} finally {
  await page.close()
  await browser.close()
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
