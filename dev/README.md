# Better Markdown dev harness

Dependency-free Chrome DevTools Protocol harness plus the live verification
script used to validate the plugin in a real `dsh web` instance.

## What it does

| File | Responsibility |
|---|---|
| `cdp.mjs` | Minimal CDP client over Node's global `WebSocket`: page creation, `eval`, `click`, `type`, `press`, screenshots, console capture, app-mount waits. |
| `verify.mjs` | 17 live checks: plugin mount, preview elements, highlight registry, switch persistence, and Markdown rendering in the durable transcript bubble. Writes `docs/preview.png` and `docs/transcript.png`. |

## Manual recipe

1. Prepare a throwaway DSH home (never `~/.dsh`) and link this checkout into
   its web profile:

   ```sh
   HOME_DIR=/tmp/dsh-bm-home
   cp -R /tmp/<some-working-dev-home> "$HOME_DIR"   # or build one from ~/.dsh
   ln -s "$PWD" "$HOME_DIR/profiles/web/node_modules/@ceasarxuu/dsh-better-markdown"
   ```

   The profile `package.json` lists the bundle and a `link:` dependency;
   `cordis.patch.yml` can stay `[]` because the bundle patch inserts the row.

2. Boot the dev instance on a non-desktop port (the desktop app owns 62184):

   ```sh
   DSH_HOME=/tmp/dsh-bm-home \
     "/Applications/DeepSeek Harness 2.app/Contents/Resources/runtime/cli/bin/dsh" \
     web --port 6291 --no-open > /tmp/dsh-bm.log 2>&1 &
   ```

3. Run the checks:

   ```sh
   node dev/verify.mjs
   ```

`verify.mjs` refuses port 62184 (the desktop session that may be hosting the
agent), reads the tokenized URL from `/tmp/dsh-bm.log`, and only talks to that
listener.

## Notes

- A dev home built this way has no `DEEPSEEK_API_KEY`; sending a message still
  writes the durable user message and renders the turn failure. That is enough
  to verify transcript rendering.
- The harness launches headless Chrome with `--no-sandbox` because the coding
  sandbox denies Chrome's own sandbox helper on macOS.
- Highlight names registered by the plugin: `bm-mark`, `bm-strong`, `bm-em`,
  `bm-strike`, `bm-code`, `bm-fence`, `bm-heading`, `bm-quote`, `bm-link`,
  `bm-list`, `bm-task`.
