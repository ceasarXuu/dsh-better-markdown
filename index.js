/**
 * Better Markdown — host half.
 *
 * The feature itself is browser work: `client.js` registers the transcript
 * renderer for user text, the composer preview dock, the toolbar switch, and
 * the CSS Custom Highlight controller that styles Markdown syntax inside the
 * Lexical composer. This host half exists for the two things only the host
 * can own:
 *
 *   1. **Durable switches.** The `Config` schema below is the plugin row's
 *      configuration in the profile patch, so a deployment changes the
 *      feature through the normal DSH plugin surface — no bespoke settings
 *      UI and no browser storage a profile reset would lose.
 *   2. **One read-only route.** `GET /plugin/better-markdown/config`
 *      publishes those switches to the browser half; `/health` lets dev
 *      tooling wait for the host surface before opening a page.
 *
 * Everything is optional and fail-open: compositions without a Web server
 * still load the row (the client half falls back to its documented
 * defaults), and the route never reads the filesystem or echoes request data.
 */
import { readFileSync } from 'node:fs'

import { toClientConfig } from './host/config.js'
import { API_PREFIX, createPluginRoute } from './host/route.js'

/**
 * Schemastery is optional at load time: a profile that links this checkout
 * directly (dev, vendored trees) may not have it installed. The switches are
 * still parsed by `toClientConfig`, so the plugin runs with or without the
 * schema-driven configuration form.
 */
const Schema = await import('@deepseek-ai/schemastery')
  .then(module => module.default ?? module)
  .catch(() => null)

/** Cordis plugin name; also the `id` of the row the bundle patch inserts. */
export const name = 'better-markdown'

/** No host service is required: the HTTP surface is attached opportunistically. */
export const inject = []

/**
 * The package version reported by `/health`. Reading the manifest keeps one
 * source of truth without a build step; a packaged install always has it.
 */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
  } catch (_manifestUnavailable) {
    return '0.0.0'
  }
})()

/**
 * Feature switches. Every field defaults to the behavior this plugin is for;
 * a profile patch only restates what it changes. The browser half reads the
 * normalized value from the route on every page load, so a change takes
 * effect after a reload.
 */
export const Config = Schema === null ? undefined : Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('Turn every Better Markdown surface on. Off restores the shipped plain-text behavior while leaving the plugin installed.'),
  transcript: Schema.boolean()
    .default(true)
    .description('Render sent user messages as Markdown in the conversation transcript.'),
  composer: Schema.boolean()
    .default(true)
    .description('Enable the composer Markdown experience: the live rendered preview and the toolbar switch.'),
  syntax: Schema.boolean()
    .default(true)
    .description('Style Markdown syntax inside the composer itself (CSS Custom Highlight API). Never changes the draft text or the sent message.'),
  preview: Schema.boolean()
    .default(true)
    .description('Show the live rendered preview above the composer by default whenever the draft contains Markdown. The toolbar switch still overrides this per browser.'),
})

/**
 * Mount the route that publishes the switches.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {Record<string, unknown>} config - validated {@link Config} value.
 */
export function apply(ctx, config) {
  const settings = toClientConfig(config)

  ctx.inject(['webServer'], (sub) => {
    let route
    try {
      route = sub.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: createPluginRoute({ config: settings, version: VERSION }),
      })
    } catch (error) {
      ctx.logger?.warn?.(`better-markdown: HTTP surface unavailable: ${String(error?.message ?? error)}`)
      return
    }
    sub.effect(() => route, 'better-markdown: HTTP surface')
  })

  ctx.logger?.info?.(
    `better-markdown: ready (enabled=${settings.enabled}, transcript=${settings.transcript}, composer=${settings.composer}, version=${VERSION})`,
  )
}
