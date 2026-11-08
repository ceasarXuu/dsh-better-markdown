# Changelog

## 0.1.0

- **Transcript.** Sent user messages render as Markdown through the keyed
  `conversation.user.text.node` slot (`text` key, priority shadow), using the
  shipped `MarkdownText` renderer. Session reference chips keep the shipped
  renderer, so `@`-mentions stay interactive; copy/quote still read the raw
  text.
- **Composer preview.** A `conversation.input.dock` entry renders the live
  draft as Markdown above the composer. Visible by default when the draft
  contains Markdown.
- **In-place syntax highlighting.** The composer draft is painted with the CSS
  Custom Highlight API (markers, emphasis, code, fences, headings, quotes,
  links, list/task markers). Paint only: no layout, draft, IME or caret change.
- **Switch.** `conversation.input.right` adds an `M↓` button; `⌘⇧M` /
  `Ctrl+Shift+M` toggles too. The browser choice persists in
  `localStorage["better-markdown.prefs.v1"]`.
- **Host half.** Config schema (`enabled`, `transcript`, `composer`, `syntax`,
  `preview`) plus a read-only `/plugin/better-markdown/{health,config}` route.
- **Chat line breaks.** Single newlines outside code/tables/indented blocks
  become CommonMark hard breaks, so multi-line messages keep their shape.
- **Tests.** 19 offline tests (config folding, HTTP surface, Markdown
  detection, hard breaks, highlight spans, store/prefs) and an 18-check live
  CDP verification against DSH 0.2.2-rc.1.
