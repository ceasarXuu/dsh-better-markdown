// Better Markdown — browser half.
//
// Two surfaces, one switch:
//
//   1. **Transcript.** Sent user messages render as Markdown. The shipped
//      `conversation.user.text` factory parses a user message into text runs
//      and reference chips, then renders each run through the keyed
//      `conversation.user.text.node` slot (keys `text` and `session`). This
//      bundle registers the `text` key at a lower priority, so every plain run
//      becomes a Markdown block. Session chips keep their own entry, so
//      @-mentions still render (and still click) exactly as shipped. The raw
//      text is only ever read: copy actions, the model-visible message, and
//      the session log are untouched.
//
//   2. **Composer.** A live rendered preview above the input plus in-place
//      syntax highlighting inside the Lexical editor. The editor is
//      shell-owned; this plugin never writes into it. Highlighting uses the
//      CSS Custom Highlight API over the editor's text nodes, so it can only
//      change paint (color/background/underline/text-shadow), never layout,
//      the draft, or the IME. The preview is a normal slot entry in
//      `conversation.input.dock`, i.e. the same flow as the shipped queue and
//      todo docks.
//
// Rendering uses the shipped Markdown component from the platform module
// table (`@deepseek-ai/dsh-client-ui-primitives`), so user messages get the
// exact GFM pipeline assistant replies use (tables, task lists, code
// highlighting, math, sanitized links). If that module is unavailable, the
// plugin degrades to plain text instead of failing the page.
window.__ModuleLoader__.load({
  id: '@ceasarxuu/dsh-better-markdown',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useMemo } = React

    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (_primitivesUnavailable) {
      primitives = null
    }
    const MarkdownText = primitives?.MarkdownText ?? null
    const UserTextRun = primitives?.UserTextRun ?? null

    /** Own locale namespace: reusing a shipped namespace (chat/common) throws. */
    const NS = 'betterMarkdown'

    /** Host route that publishes the durable switches (see index.js). */
    const API_PREFIX = '/plugin/better-markdown'

    /** Browser-local override key: one object, `{ preview: boolean | null }`. */
    const PREFS_KEY = 'better-markdown.prefs.v1'

    /** Root attribute every stylesheet rule is scoped under. */
    const ATTR = 'data-dsh-better-markdown'

    /** Highlight names registered with the CSS Custom Highlight API. */
    const HIGHLIGHT_NAMES = [
      'bm-mark', 'bm-strong', 'bm-em', 'bm-strike', 'bm-code', 'bm-fence',
      'bm-heading', 'bm-quote', 'bm-link', 'bm-list', 'bm-task',
    ]

    /** Documented defaults; keep in sync with `host/config.js`. */
    const DEFAULT_CONFIG = Object.freeze({
      enabled: true,
      transcript: true,
      composer: true,
      syntax: true,
      preview: true,
    })

    const zh = {
      'panel.title': 'Markdown 预览',
      'panel.hint': '发送时保留原始 Markdown 文本',
      'panel.close': '隐藏预览',
      'toggle.on': '关闭 Markdown 预览（⌘⇧M / Ctrl⇧M）',
      'toggle.off': '开启 Markdown 预览（⌘⇧M / Ctrl⇧M）',
      'markdown.copy': '复制',
      'markdown.copied': '已复制',
      'markdown.code': '代码',
      'markdown.wrap': '自动换行',
      'markdown.unwrap': '不换行',
      'markdown.footnotes': '脚注',
    }

    const en = {
      'panel.title': 'Markdown preview',
      'panel.hint': 'The raw Markdown text is what gets sent',
      'panel.close': 'Hide preview',
      'toggle.on': 'Turn off Markdown preview (⌘⇧M / Ctrl⇧M)',
      'toggle.off': 'Turn on Markdown preview (⌘⇧M / Ctrl⇧M)',
      'markdown.copy': 'Copy',
      'markdown.copied': 'Copied',
      'markdown.code': 'Code',
      'markdown.wrap': 'Wrap lines',
      'markdown.unwrap': 'No wrap',
      'markdown.footnotes': 'Footnotes',
    }

    /* ------------------------------------------------------------------ */
    /* 1. Tiny snapshot store + persisted browser preference.              */
    /* ------------------------------------------------------------------ */

    /**
     * Create one bare observable store (framework hooks are bound by the slot
     * renderer from the `hooks` compartments this feeds).
     * @param {unknown} initial - first snapshot.
     * @returns {{ getSnapshot: () => unknown, subscribe: (listener: () => void) => () => void, set: (next: unknown) => void }}
     */
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          if (Object.is(next, snapshot)) return
          snapshot = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /** The page's localStorage, or null where the profile denies it. */
    function localStore() {
      try {
        return globalThis.localStorage ?? globalThis.window?.localStorage ?? null
      } catch (_denied) {
        return null
      }
    }

    /** Read the persisted browser override; never throws in a locked profile. */
    function readPrefs() {
      try {
        const raw = localStore()?.getItem(PREFS_KEY)
        if (typeof raw !== 'string' || raw === '') return { preview: null }
        const parsed = JSON.parse(raw)
        return { preview: typeof parsed?.preview === 'boolean' ? parsed.preview : null }
      } catch (_unreadable) {
        return { preview: null }
      }
    }

    /** Persist the browser override; a failed write only loses the override. */
    function writePrefs(prefs) {
      try {
        localStore()?.setItem(PREFS_KEY, JSON.stringify(prefs))
      } catch (_unwritable) {
        /* private mode / quota: the in-memory value still applies */
      }
    }

    /** Fold any config payload onto the documented boolean shape. */
    function normalizeConfig(raw) {
      const source = typeof raw === 'object' && raw !== null ? raw : {}
      const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
      return {
        enabled: bool(source.enabled, DEFAULT_CONFIG.enabled),
        transcript: bool(source.transcript, DEFAULT_CONFIG.transcript),
        composer: bool(source.composer, DEFAULT_CONFIG.composer),
        syntax: bool(source.syntax, DEFAULT_CONFIG.syntax),
        preview: bool(source.preview, DEFAULT_CONFIG.preview),
      }
    }

    /* ------------------------------------------------------------------ */
    /* 2. Markdown detection, hard breaks, and highlight spans.            */
    /* ------------------------------------------------------------------ */

    /**
     * Syntax hints that justify rendering a user message as Markdown. Plain
     * prose stays byte-identical to the shipped plain-text bubble.
     */
    const SYNTAX_HINTS = [
      /^ {0,3}#{1,6}\s+\S/m,
      /^ {0,3}(?:`{3,}|~{3,})/m,
      /^ {0,3}>\s+\S/m,
      /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+\S/m,
      /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/m,
      /(?:^|[^\w*])\*\*(?=\S)[^*\n]*\*\*/,
      /(?:^|[^\w_])__(?=\S)[^_\n]*__/,
      /`[^`\n]+`/,
      /~~[^\s~][^~\n]*~~/,
      /!?\[[^\]\n]+\]\([^)\s]+\)/,
      /^ {0,3}\|[^\n]*\|/m,
      /^ {0,3}- \[[ xX]\] /m,
    ]

    /**
     * Does this text contain Markdown worth rendering?
     * @param {string} text - the user message or a text run from it.
     * @returns {boolean}
     */
    function looksLikeMarkdown(text) {
      if (typeof text !== 'string' || text === '') return false
      return SYNTAX_HINTS.some(pattern => pattern.test(text))
    }

    /** One line range, half-open offsets into the source text. */
    function lineRanges(text) {
      const lines = []
      let start = 0
      while (start <= text.length) {
        let end = text.indexOf('\n', start)
        if (end < 0) end = text.length
        lines.push({ start, end, text: text.slice(start, end) })
        if (end >= text.length) break
        start = end + 1
      }
      return lines
    }

    /** Offsets of GFM table lines (header, delimiter, and body rows). */
    function tableLineIndexes(lines) {
      const marked = new Set()
      const looksDelimiter = line => line.includes('-') && line.includes('|') && /^[\s|:-]+$/.test(line)
      for (let index = 1; index < lines.length; index += 1) {
        if (!looksDelimiter(lines[index].text)) continue
        if (!(lines[index - 1].text.includes('|') && lines[index - 1].text.trim() !== '')) continue
        let start = index - 1
        while (start > 0 && lines[start - 1].text.includes('|')) start -= 1
        let end = index
        while (end + 1 < lines.length && lines[end + 1].text.includes('|') && lines[end + 1].text.trim() !== '') end += 1
        for (let at = start; at <= end; at += 1) marked.add(at)
      }
      return marked
    }

    /**
     * Preserve chat line breaks for Markdown: a single newline outside code,
     * tables and indented blocks becomes a CommonMark hard break (two spaces),
     * so a multi-line message does not collapse into one paragraph. Code
     * content, table rows and already-hard-broken lines are left untouched.
     * @param {string} text - raw message text.
     * @returns {string} Markdown source carrying chat semantics.
     */
    function applyHardBreaks(text) {
      if (typeof text !== 'string' || !text.includes('\n')) return text
      const lines = lineRanges(text)
      const tables = tableLineIndexes(lines)
      const out = []
      let fence = null
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].text
        const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)
        if (fence !== null) {
          if (fenceMatch !== null && fenceMatch[1][0] === fence) fence = null
          out.push(line)
          continue
        }
        if (fenceMatch !== null) {
          fence = fenceMatch[1][0]
          out.push(line)
          continue
        }
        if (/^(?: {4}|\t)/.test(line) || tables.has(index)) {
          out.push(line)
          continue
        }
        const next = lines[index + 1]
        const needsBreak = next !== undefined
          && next.text.trim() !== ''
          && line.trim() !== ''
          && !/[ \t]{2,}$/.test(line)
          && !line.endsWith('\\')
          && !/^ {0,3}(?:[-*+]|\d{1,9}[.)])\s*$/.test(line)
        out.push(needsBreak ? `${line}  ` : line)
      }
      return out.join('\n')
    }

    /**
     * Tokenize Markdown into highlight spans for the composer. Block markers,
     * emphasis delimiters, code fences, links and quote/list prefixes are
     * separated from the content they wrap; only paint-level styling applies,
     * so a wrong guess is cosmetic and never changes the draft.
     * @param {string} text - draft text.
     * @returns {Array<{ name: string, start: number, end: number }>}
     */
    function markdownHighlightSpans(text) {
      if (typeof text !== 'string' || text === '') return []
      const spans = []
      const push = (name, start, end) => {
        if (Number.isInteger(start) && Number.isInteger(end) && end > start && start >= 0 && end <= text.length) {
          spans.push({ name, start, end })
        }
      }
      const lines = lineRanges(text)
      const tables = tableLineIndexes(lines)
      let fence = null

      const scanInline = (from, to) => {
        const source = text.slice(from, to)
        if (source === '') return
        const taken = []
        const free = (start, end) => taken.every(([takenStart, takenEnd]) => start >= takenEnd || end <= takenStart)
        const claim = (start, end) => { taken.push([start, end]) }
        const ease = (start, end) => ({ start: from + start, end: from + end })

        // Inline code wins over every other inline construct.
        const code = /(`+)([^`\n]+?)\1/g
        let match
        while ((match = code.exec(source)) !== null) {
          const absolute = ease(match.index, match.index + match[0].length)
          if (!free(absolute.start, absolute.end)) continue
          claim(absolute.start, absolute.end)
          const tick = match[1].length
          push('bm-mark', absolute.start, absolute.start + tick)
          push('bm-code', absolute.start + tick, absolute.end - tick)
          push('bm-mark', absolute.end - tick, absolute.end)
        }

        const strikethrough = /~~(?=\S)([\s\S]*?\S)~~/g
        while ((match = strikethrough.exec(source)) !== null) {
          const absolute = ease(match.index, match.index + match[0].length)
          if (!free(absolute.start, absolute.end)) continue
          claim(absolute.start, absolute.end)
          push('bm-mark', absolute.start, absolute.start + 2)
          push('bm-strike', absolute.start + 2, absolute.end - 2)
          push('bm-mark', absolute.end - 2, absolute.end)
        }

        const strong = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g
        while ((match = strong.exec(source)) !== null) {
          const absolute = ease(match.index, match.index + match[0].length)
          if (!free(absolute.start, absolute.end)) continue
          claim(absolute.start, absolute.end)
          push('bm-mark', absolute.start, absolute.start + 2)
          push('bm-strong', absolute.start + 2, absolute.end - 2)
          push('bm-mark', absolute.end - 2, absolute.end)
        }

        const links = /!?\[([^\]\n]*)\]\(([^)\n]*)\)/g
        while ((match = links.exec(source)) !== null) {
          const absolute = ease(match.index, match.index + match[0].length)
          if (!free(absolute.start, absolute.end)) continue
          claim(absolute.start, absolute.end)
          const labelStart = absolute.start + match[0].indexOf('[') + 1
          const labelEnd = labelStart + match[1].length
          push('bm-mark', absolute.start, labelStart)
          push('bm-link', labelStart, labelEnd)
          push('bm-mark', labelEnd, absolute.end)
        }

        const emphasis = /(?<![*\w])\*(?![\s*])([^*\n]*?\S)\*(?!\*)/g
        while ((match = emphasis.exec(source)) !== null) {
          const absolute = ease(match.index, match.index + match[0].length)
          if (!free(absolute.start, absolute.end)) continue
          claim(absolute.start, absolute.end)
          push('bm-mark', absolute.start, absolute.start + 1)
          push('bm-em', absolute.start + 1, absolute.end - 1)
          push('bm-mark', absolute.end - 1, absolute.end)
        }

        const underscore = /(?<![_\w])_(?![\s_])([^_\n]*?\S)_(?![_\w])/g
        while ((match = underscore.exec(source)) !== null) {
          const absolute = ease(match.index, match.index + match[0].length)
          if (!free(absolute.start, absolute.end)) continue
          claim(absolute.start, absolute.end)
          push('bm-mark', absolute.start, absolute.start + 1)
          push('bm-em', absolute.start + 1, absolute.end - 1)
          push('bm-mark', absolute.end - 1, absolute.end)
        }
      }

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        const raw = line.text
        const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(raw)

        if (fence !== null) {
          if (fenceMatch !== null && fenceMatch[1][0] === fence) {
            push('bm-mark', line.start + fenceMatch.index, line.start + fenceMatch.index + fenceMatch[1].length)
            fence = null
          } else {
            push('bm-fence', line.start, line.end)
          }
          continue
        }
        if (fenceMatch !== null) {
          fence = fenceMatch[1][0]
          const markerStart = line.start + fenceMatch.index
          push('bm-mark', markerStart, markerStart + fenceMatch[1].length)
          const info = raw.slice(fenceMatch.index + fenceMatch[1].length)
          if (info.trim() !== '') push('bm-mark', markerStart + fenceMatch[1].length, line.end)
          continue
        }
        if (tables.has(index)) {
          if (/^[\s|:-]+$/.test(raw)) push('bm-mark', line.start, line.end)
          else scanInline(line.start, line.end)
          continue
        }
        if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(raw)) {
          push('bm-mark', line.start, line.end)
          continue
        }

        const heading = /^( {0,3})(#{1,6})(\s+)/.exec(raw)
        if (heading !== null) {
          const markerStart = line.start + heading[1].length
          push('bm-mark', markerStart, markerStart + heading[2].length)
          push('bm-heading', line.start + heading[0].length, line.end)
          scanInline(line.start + heading[0].length, line.end)
          continue
        }

        const quote = /^( {0,3})((?:>\s?)+)/.exec(raw)
        if (quote !== null) {
          const markerStart = line.start + quote[1].length
          push('bm-mark', markerStart, markerStart + quote[2].length)
          push('bm-quote', line.start + quote[0].length, line.end)
          scanInline(line.start + quote[0].length, line.end)
          continue
        }

        const list = /^( {0,3})([-*+]|\d{1,9}[.)])(\s+)/.exec(raw)
        if (list !== null) {
          const markerStart = line.start + list[1].length
          push('bm-list', markerStart, markerStart + list[2].length)
          const restStart = line.start + list[0].length
          const task = /^\[([ xX])\](?=\s|$)/.exec(raw.slice(list[0].length))
          if (task !== null) {
            push('bm-task', restStart, restStart + task[0].length)
            scanInline(restStart + task[0].length, line.end)
          } else {
            scanInline(restStart, line.end)
          }
          continue
        }

        scanInline(line.start, line.end)
      }
      return spans
    }

    /* ------------------------------------------------------------------ */
    /* 3. Composer syntax highlighting (CSS Custom Highlight API).         */
    /* ------------------------------------------------------------------ */

    /** Text nodes of the composer in document order, chips excluded. */
    function collectTextRuns(root) {
      const runs = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const value = node.nodeValue
          if (typeof value !== 'string' || value === '') return NodeFilter.FILTER_REJECT
          const parent = node.parentElement
          if (parent === null) return NodeFilter.FILTER_REJECT
          if (parent.closest('[data-composer-chip], [data-composer-text-ref], [data-lexical-decorator]') !== null) {
            return NodeFilter.FILTER_REJECT
          }
          return NodeFilter.FILTER_ACCEPT
        },
      })
      let offset = 0
      let node
      while ((node = walker.nextNode()) !== null) {
        const value = node.nodeValue ?? ''
        runs.push({ node, start: offset, end: offset + value.length })
        offset += value.length
      }
      return { runs, text: runs.map(run => run.node.nodeValue).join('') }
    }

    /** One DOM Range for an offset span inside a single text run. */
    function rangeFor(run, start, end) {
      const range = document.createRange()
      range.setStart(run.node, start - run.start)
      range.setEnd(run.node, end - run.start)
      return range
    }

    /**
     * Install the composer painter. It polls for the resident composer element
     * (the app rebinds it between sessions), repaints on editor mutations, and
     * deletes every highlight whenever the switch is off.
     * @param {{ settings: ReturnType<typeof createStore> }} options
     * @returns {() => void} disposer.
     */
    function installComposerHighlighter({ settings }) {
      if (typeof document === 'undefined') return () => {}
      const registry = typeof globalThis.CSS === 'undefined' ? null : globalThis.CSS.highlights
      const HighlightCtor = globalThis.Highlight
      if (registry == null || typeof HighlightCtor !== 'function') return () => {}

      let editor = null
      let observer = null
      let frame = 0
      let poll = 0

      const clear = () => {
        for (const name of HIGHLIGHT_NAMES) registry.delete(name)
      }

      const enabled = () => {
        const config = settings.getSnapshot().config
        return config.enabled && config.composer && config.syntax
      }

      const paint = () => {
        if (!enabled()) {
          clear()
          return
        }
        if (editor === null || !editor.isConnected) {
          attach()
          if (editor === null) return
        }
        const { runs, text } = collectTextRuns(editor)
        if (text === '') {
          clear()
          return
        }
        const byName = new Map()
        for (const span of markdownHighlightSpans(text)) {
          for (const run of runs) {
            if (run.end <= span.start) continue
            if (run.start >= span.end) break
            const from = Math.max(span.start, run.start)
            const to = Math.min(span.end, run.end)
            if (to <= from) continue
            const list = byName.get(span.name) ?? []
            list.push(rangeFor(run, from, to))
            byName.set(span.name, list)
          }
        }
        for (const name of HIGHLIGHT_NAMES) {
          const ranges = byName.get(name)
          if (ranges === undefined || ranges.length === 0) registry.delete(name)
          else registry.set(name, new HighlightCtor(...ranges))
        }
      }

      const schedule = () => {
        if (frame !== 0) return
        frame = requestAnimationFrame(() => {
          frame = 0
          try {
            paint()
          } catch (_paintFailed) {
            /* a detached range must never break typing */
          }
        })
      }

      const detach = () => {
        if (observer !== null) observer.disconnect()
        observer = null
        if (editor !== null) {
          editor.removeEventListener('input', schedule)
          editor.removeEventListener('compositionend', schedule)
        }
        editor = null
      }

      const attach = () => {
        const next = document.querySelector('[data-composer-input]')
        if (next === editor) return
        detach()
        editor = next
        if (editor === null) {
          clear()
          return
        }
        editor.addEventListener('input', schedule)
        editor.addEventListener('compositionend', schedule)
        observer = new MutationObserver(schedule)
        observer.observe(editor, { subtree: true, childList: true, characterData: true })
        schedule()
      }

      const onFocus = () => { attach(); schedule() }

      const unsubscribe = settings.subscribe(() => schedule())
      document.addEventListener('focusin', onFocus)
      attach()
      poll = globalThis.setInterval(() => {
        if (!enabled()) {
          clear()
          return
        }
        attach()
      }, 1200)

      return () => {
        unsubscribe()
        document.removeEventListener('focusin', onFocus)
        if (poll !== 0) globalThis.clearInterval(poll)
        poll = 0
        if (frame !== 0) cancelAnimationFrame(frame)
        frame = 0
        detach()
        clear()
      }
    }

    /* ------------------------------------------------------------------ */
    /* 4. Icons.                                                          */
    /* ------------------------------------------------------------------ */

    /** Markdown mark: an "M" beside a downward arrow. */
    function MarkdownGlyph({ size = 14 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        'aria-hidden': true,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }, [
        h('path', { key: 'm', d: 'M2.4 5v6M2.4 5.1 4.9 7.8 7.4 5.1v5.9' }),
        h('path', { key: 'arrow', d: 'M11.1 4.9v5.3M9.2 8.4l1.9 2 1.9-2' }),
      ])
    }

    /** Small close cross for the preview header. */
    function CloseGlyph({ size = 12 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        'aria-hidden': true,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
      }, h('path', { d: 'M4 4l8 8M12 4l-8 8' }))
    }

    /* ------------------------------------------------------------------ */
    /* 5. Markdown rendering.                                             */
    /* ------------------------------------------------------------------ */

    /** Localized chrome for the shipped Markdown renderer. */
    function useMarkdownLabels(t) {
      return useMemo(() => ({
        code: {
          copyLabel: t('markdown.copy'),
          copiedLabel: t('markdown.copied'),
          toolbarLabels: {
            codeLabel: t('markdown.code'),
            wrapLabel: t('markdown.wrap'),
            unwrapLabel: t('markdown.unwrap'),
          },
        },
        footnotes: t('markdown.footnotes'),
      }), [t])
    }

    /** One Markdown body inside the plugin's scoping wrapper. */
    function MarkdownBody({ text, labels }) {
      const source = useMemo(() => applyHardBreaks(text), [text])
      if (MarkdownText === null) {
        return h('div', { className: 'bm-md-fallback', whiteSpace: 'pre-wrap' }, source)
      }
      return h(MarkdownText, { text: source, labels })
    }

    /** Plain text exactly as the shipped renderer draws it. */
    function plainRun(text) {
      if (UserTextRun !== null) return h(UserTextRun, { text })
      return h('span', null, text)
    }

    /**
     * `conversation.user.text.node` entry for the `text` key: the shipped
     * plain-text cell, upgraded to Markdown when the run carries syntax.
     * @param {object} props - parser node, raw substring, translation.
     */
    function MarkdownUserText({ node, raw, t, useSettings }) {
      const enabled = useSettings(state => state.config.enabled && state.config.transcript)
      const data = node?.data ?? {}
      const text = typeof data.text === 'string' ? data.text : String(raw ?? '')
      const labels = useMarkdownLabels(t)
      // Whitespace-normalization nodes carry a display form; keep them plain.
      if (typeof data.display === 'string') return plainRun(data.display)
      if (!enabled || !looksLikeMarkdown(text)) return plainRun(text)
      return h('div', { className: 'bm-md bm-md-bubble', 'data-bm-markdown': 'bubble' },
        h(MarkdownBody, { text, labels }))
    }

    /* ------------------------------------------------------------------ */
    /* 6. Composer preview dock + toolbar switch.                         */
    /* ------------------------------------------------------------------ */

    /**
     * `conversation.input.dock` entry: the live rendered draft. Visible only
     * when the switch is on, the draft is non-empty, and the draft either
     * contains Markdown (the auto default) or the reader explicitly turned
     * the preview on for everything.
     * @param {object} props - InputZone owner data, translation, stores.
     */
    function MarkdownPreviewDock({ input, t, useSettings, togglePreview }) {
      const config = useSettings(state => state.config)
      const pref = useSettings(state => state.prefs.preview)
      const labels = useMarkdownLabels(t)
      const draft = typeof input?.draft === 'string' ? input.draft : ''
      const auto = pref === null
      const visible = config.enabled
        && config.composer
        && (auto ? config.preview : pref)
        && draft.trim() !== ''
        && (!auto || looksLikeMarkdown(draft))
      if (!visible) return null
      return h('section', {
        className: 'bm-preview',
        'data-bm-preview': '',
        'aria-label': t('panel.title'),
      }, [
        h('header', { key: 'head', className: 'bm-preview-head' }, [
          h('span', { key: 'glyph', className: 'bm-preview-glyph' }, h(MarkdownGlyph, { size: 14 })),
          h('span', { key: 'title', className: 'bm-preview-title' }, t('panel.title')),
          h('span', { key: 'hint', className: 'bm-preview-hint' }, t('panel.hint')),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'bm-icon-btn',
            title: t('panel.close'),
            'aria-label': t('panel.close'),
            onMouseDown: event => { event.preventDefault() },
            onClick: event => { event.preventDefault(); togglePreview() },
          }, h(CloseGlyph, { size: 12 })),
        ]),
        h('div', { key: 'body', className: 'bm-preview-body' },
          h('div', { className: 'bm-md' }, h(MarkdownBody, { text: draft, labels }))),
      ])
    }

    /**
     * `conversation.input.right` entry: the switch. Pressed state mirrors the
     * effective value (browser override, else the host default).
     * @param {object} props - translation, stores, toggle callback.
     */
    function MarkdownPreviewToggle({ t, useSettings, togglePreview }) {
      const available = useSettings(state => state.config.enabled && state.config.composer)
      const fallback = useSettings(state => state.config.preview)
      const pref = useSettings(state => state.prefs.preview)
      if (!available) return null
      const active = pref === null ? fallback : pref
      return h('button', {
        type: 'button',
        className: 'bm-toggle',
        'data-active': active ? 'on' : 'off',
        'aria-pressed': active,
        title: active ? t('toggle.on') : t('toggle.off'),
        'aria-label': active ? t('toggle.on') : t('toggle.off'),
        onMouseDown: event => { event.preventDefault() },
        onClick: event => { event.preventDefault(); togglePreview() },
      }, h(MarkdownGlyph, { size: 14 }))
    }

    /* ------------------------------------------------------------------ */
    /* 7. Plugin body.                                                    */
    /* ------------------------------------------------------------------ */

    /** The single stylesheet; scoped under the root attribute. */
    const STYLESHEET = `
html[${ATTR}="on"] ::highlight(bm-mark) {
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, #8a8f98));
}
html[${ATTR}="on"] ::highlight(bm-strong) {
  color: var(--dsw-alias-label-primary);
  text-shadow: 0.35px 0 0 currentColor;
}
html[${ATTR}="on"] ::highlight(bm-em) {
  color: var(--dsw-alias-label-primary);
  text-shadow: 0.2px 0 0 currentColor;
}
html[${ATTR}="on"] ::highlight(bm-strike) {
  color: var(--dsw-alias-label-secondary);
  text-decoration: line-through;
}
html[${ATTR}="on"] ::highlight(bm-code) {
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
  background-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 12%, transparent);
}
html[${ATTR}="on"] ::highlight(bm-fence) {
  background-color: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 7%, transparent);
}
html[${ATTR}="on"] ::highlight(bm-heading) {
  color: var(--dsw-alias-label-primary);
  text-shadow: 0.55px 0 0 currentColor;
}
html[${ATTR}="on"] ::highlight(bm-quote) {
  color: var(--dsw-alias-label-secondary);
}
html[${ATTR}="on"] ::highlight(bm-link) {
  color: var(--dsw-alias-link, var(--dsw-alias-state-business-primary, #4d6bfe));
  text-decoration: underline;
  text-underline-offset: 2px;
}
html[${ATTR}="on"] ::highlight(bm-list) {
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
}
html[${ATTR}="on"] ::highlight(bm-task) {
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
  background-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 14%, transparent);
}

[data-bm-preview] {
  /* The hero composer is a height-constrained flex column; never let the
     preview shrink below its content (it would clip the rendered body). */
  flex: 0 0 auto;
  box-sizing: border-box;
  width: calc(100% - 2 * var(--dsh-composer-side-clearance, 16px));
  max-width: var(--dsh-composer-card-max-width, 780px);
  margin: 0 auto 2px;
  border: 1px solid var(--dsw-alias-border-l1, rgb(255 255 255 / 10%));
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1)));
  box-shadow: var(--dsw-elevation-soft, none);
  overflow: hidden;
}
.bm-preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px 5px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgb(255 255 255 / 10%));
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.bm-preview-glyph {
  display: inline-flex;
  align-items: center;
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
}
.bm-preview-title {
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  flex: none;
}
.bm-preview-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary));
}
.bm-preview-body {
  max-height: min(36vh, 320px);
  overflow: auto;
  padding: 2px 12px 6px;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.bm-icon-btn {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.bm-icon-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.bm-icon-btn:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.bm-toggle {
  flex: none;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.bm-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.bm-toggle[data-active="on"] {
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
}
.bm-toggle:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}

/* Markdown blocks inside a message bubble or the preview panel: the shipped
   renderer is tuned for full-width assistant replies, so tighten the vertical
   rhythm and keep headings from dwarfing a narrow bubble. */
.bm-md {
  min-width: 0;
  white-space: normal;
}
.bm-md > div {
  font-size: inherit;
}
.bm-md > div > :first-child {
  margin-top: 0;
}
.bm-md > div > :last-child {
  margin-bottom: 0;
}
.bm-md :where(p) {
  margin: 0 0 8px;
}
.bm-md :where(p:last-child) {
  margin-bottom: 0;
}
.bm-md :where(ul, ol) {
  margin: 6px 0 8px;
}
.bm-md :where(h1, h2, h3, h4, h5, h6) {
  margin: 10px 0 4px;
  font-size: 1.06em;
  line-height: 1.4;
}
.bm-md :where(h1, h2) {
  font-size: 1.12em;
}
.bm-md :where(pre, blockquote, table) {
  margin: 8px 0;
}
.bm-md :where(hr) {
  margin: 10px 0;
}
.bm-md :where(blockquote) {
  border-left-width: 2px;
  padding-left: 10px;
}
[data-message-bubble] .bm-md {
  word-break: break-word;
}

/* The queue dock renders the same factory into a one-line ellipsis preview. */
[class*="ellipsis"] > .bm-md {
  max-height: 1.6em;
  overflow: hidden;
}
[class*="ellipsis"] > .bm-md > div > :where(p, ul, ol, li, pre, blockquote, table, h1, h2, h3, h4, h5, h6) {
  display: inline;
  margin: 0;
  padding: 0;
  font-size: inherit;
  line-height: inherit;
  border: none;
}
[class*="ellipsis"] > .bm-md > div > :where(br) {
  display: none;
}
`

    /**
     * Mount both surfaces.
     * @param {import('@deepseek-ai/cordis').Context} ctx - client plugin context.
     */
    function apply(ctx) {
      const settings = createStore({
        config: { ...DEFAULT_CONFIG },
        prefs: readPrefs(),
      })

      const togglePreview = () => {
        const state = settings.getSnapshot()
        const effective = state.prefs.preview === null ? state.config.preview : state.prefs.preview
        const next = { preview: !effective }
        writePrefs(next)
        settings.set({ ...state, prefs: next })
      }

      ctx.effect(() => {
        const root = document.documentElement
        root.setAttribute(ATTR, 'on')
        return () => { root.removeAttribute(ATTR) }
      }, 'better-markdown: root attribute')

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = '@ceasarxuu/dsh-better-markdown'
        tag.textContent = STYLESHEET
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, 'better-markdown: stylesheet')

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'better-markdown: dictionaries')

      ctx.effect(() => {
        let cancelled = false
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const timer = controller === null ? 0 : setTimeout(() => controller.abort(), 3000)
        const load = async () => {
          try {
            const response = await fetch(`${API_PREFIX}/config`, {
              cache: 'no-store',
              headers: { accept: 'application/json' },
              ...(controller === null ? {} : { signal: controller.signal }),
            })
            if (!response.ok) return
            const body = await response.json()
            if (cancelled) return
            settings.set({ ...settings.getSnapshot(), config: normalizeConfig(body?.config) })
          } catch (_configUnavailable) {
            /* the documented defaults already apply */
          } finally {
            if (timer !== 0) clearTimeout(timer)
          }
        }
        void load()
        return () => {
          cancelled = true
          if (timer !== 0) clearTimeout(timer)
          controller?.abort()
        }
      }, 'better-markdown: host config')

      ctx.effect(() => installComposerHighlighter({ settings }), 'better-markdown: composer highlighting')

      // Transcript: shadow the shipped plain-text cell for the `text` key.
      // Priority 0 renders ahead of the shipped 100 without replacing the
      // `session` key, so reference chips keep their own renderer.
      ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
        name: 'conversation.user.text.node',
        key: 'text',
        priority: 0,
        locale: NS,
        inject: () => ({ hooks: { settings } }),
      }, MarkdownUserText))

      // Composer: the live preview dock and its toolbar switch.
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'better-markdown-preview',
        order: 50,
        locale: NS,
        inject: () => ({ hooks: { settings }, togglePreview }),
      }, MarkdownPreviewDock))

      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'better-markdown-toggle',
        order: 10,
        locale: NS,
        inject: () => ({ hooks: { settings }, togglePreview }),
      }, MarkdownPreviewToggle))

      // Keyboard switch. Capture phase, no modifier collisions with typing.
      ctx.effect(() => {
        const onKeyDown = (event) => {
          if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return
          if (typeof event.key !== 'string' || event.key.toLowerCase() !== 'm') return
          const config = settings.getSnapshot().config
          if (!config.enabled || !config.composer) return
          event.preventDefault()
          togglePreview()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => { document.removeEventListener('keydown', onKeyDown, true) }
      }, 'better-markdown: keyboard switch')
    }

    const exports = { inject: ['slots', 'locale'], apply }

    // Offline test seam: expose the pure helpers to `node --test` without a
    // browser. Production exports stay the two module-loader contracts above.
    if (typeof window !== 'undefined' && window.__BETTER_MARKDOWN_TEST__ === true) {
      exports.__test = {
        DEFAULT_CONFIG,
        HIGHLIGHT_NAMES,
        looksLikeMarkdown,
        applyHardBreaks,
        markdownHighlightSpans,
        normalizeConfig,
        createStore,
        readPrefs,
        writePrefs,
      }
    }

    return exports
  },
})
