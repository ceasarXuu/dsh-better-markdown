/**
 * Better Markdown switches — the single normalization point between the
 * Schemastery `Config` the Loader validates and the JSON the browser half
 * consumes.
 *
 * The browser half must stay usable when the host route is unavailable (a
 * shell-only composition, a direct client bundle test), so every field has a
 * documented default here and in `client.js`. The package tests assert that
 * the defaults below round-trip through the route.
 */

/** Shape served to the browser; every field is a boolean. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  transcript: true,
  composer: true,
  syntax: true,
  preview: true,
})

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Fold an arbitrary Loader config into the exact wire shape the client reads.
 * Unknown keys are dropped and wrong types fall back to their default, so an
 * old profile patch never breaks a new client build. The result is frozen so
 * a later mutation cannot change what the route serves.
 *
 * @param {Record<string, unknown> | undefined} raw
 * @returns {Readonly<typeof DEFAULTS>}
 */
export function toClientConfig(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {}
  return Object.freeze({
    enabled: bool(source.enabled, DEFAULTS.enabled),
    transcript: bool(source.transcript, DEFAULTS.transcript),
    composer: bool(source.composer, DEFAULTS.composer),
    syntax: bool(source.syntax, DEFAULTS.syntax),
    preview: bool(source.preview, DEFAULTS.preview),
  })
}
