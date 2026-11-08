/**
 * The plugin's HTTP surface on the DSH host web server.
 *
 * Everything the feature owns lives in the browser bundle, so the host only
 * publishes the effective switches:
 *
 *   GET /plugin/better-markdown/health  → liveness probe for dev scripts
 *   GET /plugin/better-markdown/config  → the normalized switches, no-store
 *
 * Requests are same-origin reads only. No filesystem access, no writes, no
 * credentials, and no path that echoes the request URL — the handler is a
 * closed surface safe to mount in any Web composition. `webServer.register`
 * matches the longest prefix, so every unknown child path returns a JSON 404
 * instead of falling through to the SPA.
 */

/** Route prefix owned on the host web server; keep in sync with client.js. */
export const API_PREFIX = '/plugin/better-markdown'

const ALLOW = 'GET, HEAD'

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {{ noStore?: boolean }} [options]
 */
function sendJson(res, status, body, options = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': options.noStore === true ? 'no-store' : 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

/**
 * Build the prefix handler mounted at {@link API_PREFIX}.
 *
 * @param {object} options
 * @param {Readonly<Record<string, unknown>>} options.config - normalized switches.
 * @param {string} [options.version] - package version reported by /health.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createPluginRoute({ config, version = '0.0.0' }) {
  if (typeof config !== 'object' || config === null) {
    throw new TypeError('better-markdown: createPluginRoute needs a normalized config object')
  }
  const frozen = Object.freeze({ ...config })

  return function handle(req, res) {
    try {
      const method = req.method ?? 'GET'
      if (method !== 'GET' && method !== 'HEAD') {
        res.setHeader('allow', ALLOW)
        sendJson(res, 405, { error: { code: 'method-not-allowed', message: `use ${ALLOW}` } })
        return
      }

      let pathname
      try {
        pathname = new URL(req.url ?? '/', 'http://better-markdown.invalid').pathname
      } catch (_malformed) {
        sendJson(res, 400, { error: { code: 'bad-request', message: 'unparsable request URL' } })
        return
      }

      const suffix = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : ''

      if (suffix === '/health') {
        sendJson(res, 200, { ok: true, name: 'better-markdown', version })
        return
      }

      if (suffix === '/config') {
        sendJson(res, 200, { version, config: frozen }, { noStore: true })
        return
      }

      sendJson(res, 404, {
        error: {
          code: 'not-found',
          message: 'Better Markdown exposes only /health and /config',
        },
      })
    } catch (_unexpected) {
      // A route handler must never take the host server down with it.
      try {
        sendJson(res, 500, { error: { code: 'internal', message: 'better-markdown route failed' } })
      } catch (_alreadySent) {
        /* response was already ended by a partial write */
      }
    }
  }
}
