#!/usr/bin/env node
/**
 * Better Markdown — minimal Chrome DevTools Protocol client (no dependencies).
 *
 * The dev harness drives a real headless Chrome so screenshots and DOM probes
 * see exactly what a user sees (fonts, media queries, event handling). Node 22+
 * ships a global `WebSocket`, so this file needs nothing but the standard
 * library.
 *
 * Typical use:
 *
 *   import { ensureBrowser, connect } from './cdp.mjs'
 *   const browser = await ensureBrowser()          // reuse :9334 or launch Chrome
 *   const page = await browser.createPage({ url })
 *   await page.click({ selector: 'button' })
 *   await page.screenshot('/tmp/shot.png')
 *   await page.close()
 *
 * The browser is only launched when no CDP endpoint answers, so an externally
 * managed headless Chrome (`--remote-debugging-port=9334`) is reused and never
 * killed. A Chrome this module launched is stopped by `browser.close()`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn } from 'node:child_process'

export const DEFAULT_CDP_ENDPOINT =
  process.env.BM_CDP_URL ?? process.env.CDP_URL ?? 'http://127.0.0.1:9334'

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

/** Error raised for a protocol-level failure (not for JS exceptions in eval). */
export class CdpError extends Error {
  constructor(message, details) {
    super(message)
    this.name = 'CdpError'
    this.details = details
  }
}

async function fetchJson(url, timeoutMs = 2000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    return await response.json()
  } catch (_unreachable) {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Is a CDP browser already listening at `endpoint`? */
export async function probeBrowser(endpoint = DEFAULT_CDP_ENDPOINT) {
  return fetchJson(`${endpoint.replace(/\/$/, '')}/json/version`)
}

/**
 * Reuse a running CDP browser or launch a throwaway headless Chrome.
 *
 * @param {object} [options]
 * @param {string} [options.endpoint] - CDP HTTP endpoint (default :9334).
 * @param {boolean} [options.launch] - launch Chrome when nothing answers.
 * @param {string} [options.userDataDir] - Chrome profile dir (temp by default).
 * @param {boolean} [options.verbose] - echo Chrome's stderr? (never by default)
 * @returns {Promise<{endpoint: string, version: object|null, owned: boolean, createPage: Function, close: Function}>}
 */
export async function ensureBrowser(options = {}) {
  const endpoint = (options.endpoint ?? DEFAULT_CDP_ENDPOINT).replace(/\/$/, '')
  let version = await probeBrowser(endpoint)
  if (version) {
    const browser = await connect({ endpoint })
    return { ...browser, version, owned: false, close: async () => browser.close() }
  }
  if (options.launch === false) {
    throw new CdpError(`no CDP endpoint at ${endpoint} (set BM_CDP_URL or start Chrome with --remote-debugging-port)`)
  }

  const chrome = CHROME_CANDIDATES.find((candidate) => {
    try {
      return candidate.length > 0
    } catch (_missing) {
      return false
    }
  })
  if (!chrome) {
    throw new CdpError('Chrome not found; set CHROME_PATH or BM_CDP_URL')
  }
  const port = Number(new URL(endpoint).port || 9222)
  const userDataDir = options.userDataDir ?? '/tmp/bm-chrome-cdp'
  mkdirSync(userDataDir, { recursive: true })
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    'about:blank',
  ]
  const child = spawn(chrome, args, {
    stdio: options.verbose ? 'inherit' : 'ignore',
    detached: true,
  })
  child.unref()

  const deadline = Date.now() + (options.timeoutMs ?? 15_000)
  while (Date.now() < deadline) {
    version = await probeBrowser(endpoint)
    if (version) break
    await delay(200)
  }
  if (!version) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (_alreadyGone) {
      try { child.kill('SIGTERM') } catch (_noop) { /* ignore */ }
    }
    throw new CdpError(`Chrome did not expose CDP at ${endpoint}`)
  }
  const browser = await connect({ endpoint })
  return {
    ...browser,
    version,
    owned: true,
    close: async () => {
      await browser.close()
      try { process.kill(-child.pid, 'SIGTERM') } catch (_closed) { /* already gone */ }
    },
  }
}

/**
 * Connect to the browser-level WebSocket.
 * @param {object} [options]
 * @param {string} [options.endpoint] - CDP HTTP endpoint.
 * @returns {Promise<{send: Function, createPage: Function, close: Function, endpoint: string}>}
 */
export async function connect(options = {}) {
  const endpoint = (options.endpoint ?? DEFAULT_CDP_ENDPOINT).replace(/\/$/, '')
  const version = await fetchJson(`${endpoint}/json/version`, options.timeoutMs ?? 5_000)
  if (!version?.webSocketDebuggerUrl) {
    throw new CdpError(`cannot read /json/version from ${endpoint}`)
  }

  const socket = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CdpError('timed out opening CDP WebSocket')), 10_000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', (event) => {
      clearTimeout(timer)
      reject(new CdpError('CDP WebSocket failed to open', event?.message))
    }, { once: true })
  })

  let nextId = 0
  const pending = new Map()
  const sessionListeners = new Map()

  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString())
    } catch (_malformed) {
      return
    }
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new CdpError(message.error.message, message.error))
      else entry.resolve(message.result)
      return
    }
    const listeners = sessionListeners.get(message.sessionId)
    if (listeners) {
      for (const listener of listeners) {
        try { listener(message.method, message.params ?? {}) } catch (_listenerFailed) { /* reporting is best-effort */ }
      }
    }
  })

  socket.addEventListener('close', () => {
    for (const entry of pending.values()) entry.reject(new CdpError('CDP socket closed'))
    pending.clear()
  })

  function send(method, params = {}, sessionId) {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try {
        socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
      } catch (error) {
        pending.delete(id)
        reject(new CdpError(`cannot send ${method}: ${error.message}`))
      }
    })
  }

  /** Open a new tab, attach, configure it, and navigate. */
  async function createPage(pageOptions = {}) {
    const width = pageOptions.width ?? 1440
    const height = pageOptions.height ?? 900
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    const call = (method, params = {}) => send(method, params, sessionId)

    const consoleMessages = []
    const pageErrors = []
    const listeners = new Set()
    if (!sessionListeners.has(sessionId)) sessionListeners.set(sessionId, listeners)
    listeners.add((method, params) => {
      if (method === 'Runtime.consoleAPICalled') {
        const args = (params.args ?? []).map((arg) =>
          arg.value !== undefined ? String(arg.value) : (arg.description ?? arg.type ?? ''))
        consoleMessages.push({
          kind: 'console',
          type: params.type,
          text: args.join(' '),
          at: Date.now(),
        })
      } else if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails ?? {}
        const text = details.exception?.description ?? details.text ?? 'uncaught exception'
        pageErrors.push({ kind: 'exception', text, at: Date.now() })
        consoleMessages.push({ kind: 'exception', type: 'error', text, at: Date.now() })
      } else if (method === 'Log.entryAdded') {
        const entry = params.entry ?? {}
        consoleMessages.push({
          kind: 'log',
          type: entry.level ?? 'info',
          text: entry.text ?? '',
          url: entry.url,
          at: Date.now(),
        })
      }
    })

    await call('Page.enable')
    await call('Runtime.enable')
    await call('Log.enable')
    // Clear per-browser overrides before app code runs: screenshots must show
    // the profile config, not a previous run's local switches.
    if (Array.isArray(pageOptions.clearStorageKeys) && pageOptions.clearStorageKeys.length > 0) {
      await call('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => { try { for (const key of ${JSON.stringify(pageOptions.clearStorageKeys)}) localStorage.removeItem(key) } catch (_storageUnavailable) {} })()`,
      })
    }
    if (Array.isArray(pageOptions.initScripts)) {
      for (const source of pageOptions.initScripts) {
        await call('Page.addScriptToEvaluateOnNewDocument', { source })
      }
    }
    await call('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: pageOptions.deviceScaleFactor ?? 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    })
    if (pageOptions.colorScheme || pageOptions.reducedMotion !== undefined) {
      await call('Emulation.setEmulatedMedia', {
        features: mediaFeatures(pageOptions),
      })
    }

    let closed = false
    const page = {
      targetId,
      sessionId,
      width,
      height,
      consoleMessages,
      pageErrors,
      call,
      /** Evaluate an expression in the page and return its value. */
      async eval(expression) {
        const result = await call('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        })
        if (result.exceptionDetails) {
          const description = result.exceptionDetails.exception?.description
            ?? result.exceptionDetails.text
            ?? 'page evaluation failed'
          throw new CdpError(description, result.exceptionDetails)
        }
        return result.result?.value
      },
      /** Poll `expression` until it returns truthy or the timeout fires. */
      async waitFor(expression, { timeout = 30_000, interval = 200, label = expression } = {}) {
        const deadline = Date.now() + timeout
        let lastError = null
        while (Date.now() < deadline) {
          try {
            const value = await page.eval(expression)
            if (value) return value
          } catch (error) {
            lastError = error
          }
          await delay(interval)
        }
        throw new CdpError(
          `timed out waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ''}`,
        )
      },
      async navigate(url, { timeout = 30_000 } = {}) {
        await call('Page.navigate', { url })
        await page.waitFor('document.readyState === "complete"', { timeout, label: 'page load' })
      },
      /**
       * Wait for the DSH shell, dismiss the one-time preview notice, wait for
       * fonts, then settle.
       */
      async waitForApp(options = {}) {
        const timeout = options.timeout ?? 30_000
        await page.waitFor('document.readyState !== "loading"', { timeout, label: 'document ready' })
        await page.waitFor('Boolean(document.querySelector("[data-slot=\\"root\\"], #root > *"))', {
          timeout,
          label: 'DSH app mount',
        })
        // One-time preview-version notice. It appears over the shell; click
        // 继续 so scenarios never photograph the onboarding dialog by accident.
        await page.dismissPreviewNotice({ timeout: options.noticeTimeout ?? 4_000 }).catch(() => {})
        if (options.expectPlugin !== false) {
          await page.waitFor('document.documentElement.getAttribute("data-dsh-better-markdown") === "on"', {
            timeout: options.pluginTimeout ?? 10_000,
            label: 'Better Markdown mount',
          })
        }
        await page.eval('document.fonts.ready.then(() => true)')
        await page.eval('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => true)')
        await delay(options.settle ?? 500)
      },
      /** Click 继续 in the preview notice if it is showing. Returns true when clicked. */
      async dismissPreviewNotice({ timeout = 4_000 } = {}) {
        const deadline = Date.now() + timeout
        while (Date.now() < deadline) {
          const clicked = await page.eval(`(() => {
            const candidates = [...document.querySelectorAll('button, [role="button"]')]
            const button = candidates.find((el) => (el.textContent || '').trim() === '继续')
            if (!button) return false
            button.click()
            return true
          })()`)
          if (clicked) {
            await delay(400)
            return true
          }
          await delay(200)
        }
        return false
      },
      /**
       * Click an element with real mouse events.
       * @param {string | {selector?: string, text?: string, index?: number, exact?: boolean}} target
       */
      async click(target) {
        const spec = typeof target === 'string' ? { selector: target } : target
        const selector = spec.selector ?? 'button, [role="button"], [role="menuitem"], [role="treeitem"], [role="option"], [role="tab"], a, [data-slot]'
        const found = await page.eval(`(() => {
          const spec = ${JSON.stringify({
            selector,
            text: spec.text ?? null,
            index: spec.index ?? 0,
            exact: spec.exact === true,
          })}
          const all = [...document.querySelectorAll(spec.selector)]
          const visible = all.filter((el) => {
            const rect = el.getBoundingClientRect()
            const style = getComputedStyle(el)
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
          })
          const matches = spec.text === null ? visible : visible.filter((el) => {
            const text = (el.textContent || '').replace(/\\s+/g, ' ').trim()
            return spec.exact ? text === spec.text : text.includes(spec.text)
          })
          const el = matches[spec.index]
          if (!el) return { ok: false, count: matches.length, total: all.length }
          const before = el.getBoundingClientRect()
          const inViewport = before.top >= 0 && before.left >= 0
            && before.bottom <= window.innerHeight && before.right <= window.innerWidth
          // Scrolling the composer into view can scroll the whole document and
          // shift the app shell; only scroll when the target is actually offscreen.
          if (!inViewport) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
          const rect = el.getBoundingClientRect()
          return {
            ok: true,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            width: rect.width,
            height: rect.height,
            scrolled: !inViewport,
            text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
            tag: el.tagName,
          }
        })()`)
        if (!found?.ok) {
          throw new CdpError(
            `click target not found: ${spec.selector ?? selector}${spec.text ? ` text~${JSON.stringify(spec.text)}` : ''} (visible=${found?.count ?? 0}/${found?.total ?? 0})`,
          )
        }
        await delay(120)
        // Re-measure after smooth/snap scrolling settled.
        const point = await page.eval(`(() => {
          const el = document.elementFromPoint(${found.x}, ${found.y})
          return { x: ${found.x}, y: ${found.y}, hit: el ? el.tagName : null }
        })()`)
        const x = point?.x ?? found.x
        const y = point?.y ?? found.y
        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
        return { ...found, x, y }
      },
      /** Focus an element and insert text (works with Lexical contenteditable). */
      async type(selector, text, { clear = false } = {}) {
        const focused = await page.eval(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)})
          if (!el) return false
          el.focus()
          if (${clear ? 'true' : 'false'}) {
            if (typeof el.select === 'function') el.select()
            else {
              const range = document.createRange()
              range.selectNodeContents(el)
              const selection = window.getSelection()
              selection.removeAllRanges()
              selection.addRange(range)
            }
          }
          return true
        })()`)
        if (!focused) throw new CdpError(`type target not found: ${selector}`)
        await call('Input.insertText', { text })
        return true
      },
      /** Dispatch a single key press (Enter, Escape, Tab, ...). */
      async press(key, { modifiers = 0 } = {}) {
        const codes = {
          Enter: { code: 'Enter', windowsVirtualKeyCode: 13 },
          Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
          Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
          Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
          ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
          ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
        }
        const info = codes[key] ?? { code: key, windowsVirtualKeyCode: 0 }
        await call('Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers, ...info })
        await call('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers, ...info })
        return true
      },
      /** Move the pointer without clicking (dismisses hover tooltips). */
      async moveMouse(x, y) {
        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
        return true
      },
      /** Emulate prefers-color-scheme / prefers-reduced-motion. */
      async setMedia(media = {}) {
        await call('Emulation.setEmulatedMedia', { features: mediaFeatures({ ...media }) })
        // Let style recalc and any change listeners run.
        await page.eval('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => true)')
        return true
      },
      /** Capture a PNG. `fullPage` captures the document; `clip` crops a region. */
      async screenshot(path, { fullPage = false, clip = null } = {}) {
        let params = { format: 'png', fromSurface: true, captureBeyondViewport: fullPage }
        if (clip) {
          params = {
            ...params,
            captureBeyondViewport: true,
            clip: {
              x: clip.x,
              y: clip.y,
              width: clip.width,
              height: clip.height,
              scale: clip.scale ?? 1,
            },
          }
        } else if (fullPage) {
          const metrics = await call('Page.getLayoutMetrics')
          const size = metrics.contentSize ?? metrics.cssContentSize
          if (size) {
            params = {
              ...params,
              clip: {
                x: 0,
                y: 0,
                width: Math.ceil(size.width),
                height: Math.ceil(size.height),
                scale: 1,
              },
            }
          }
        }
        const shot = await call('Page.captureScreenshot', params)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, Buffer.from(shot.data, 'base64'))
        return path
      },
      /** Reload and wait for the app/plugin again. */
      async reload(options = {}) {
        await call('Page.reload', { ignoreCache: options.ignoreCache !== false })
        await page.waitFor('document.readyState === "complete"', { timeout: options.timeout ?? 30_000, label: 'reload' })
        await page.waitForApp(options)
        return true
      },
      /** All console entries, optionally filtered to a level. */
      consoleOf(type) {
        return type === undefined
          ? [...consoleMessages]
          : consoleMessages.filter((message) => message.type === type)
      },
      /** Plugin-related console errors (mount failures, uncaught exceptions). */
      pluginErrors() {
        return [...pageErrors, ...consoleMessages.filter((message) =>
          message.type === 'error'
          && (/better-markdown/i.test(message.text) || /bm-/i.test(message.text))
        )]
      },
      async close() {
        if (closed) return
        closed = true
        listeners.clear()
        sessionListeners.delete(sessionId)
        try { await send('Target.closeTarget', { targetId }) } catch (_alreadyClosed) { /* tab gone */ }
      },
    }

    if (pageOptions.url) {
      await page.navigate(pageOptions.url)
      if (pageOptions.waitForApp !== false) await page.waitForApp(pageOptions)
    }
    return page
  }

  async function close() {
    try { socket.close() } catch (_alreadyClosed) { /* ignore */ }
  }

  return { send, createPage, close, endpoint, version }
}

function mediaFeatures({ colorScheme, reducedMotion }) {
  const features = []
  if (colorScheme) features.push({ name: 'prefers-color-scheme', value: colorScheme })
  if (reducedMotion !== undefined) {
    features.push({ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' })
  }
  return features
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const endpoint = process.argv[2] ?? DEFAULT_CDP_ENDPOINT
  const version = await probeBrowser(endpoint)
  if (!version) {
    console.error(`no CDP endpoint at ${endpoint}`)
    process.exitCode = 1
  } else {
    console.log(JSON.stringify({ endpoint, Browser: version.Browser, webSocketDebuggerUrl: version.webSocketDebuggerUrl }, null, 2))
  }
}
