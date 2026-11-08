import assert from 'node:assert/strict'
import { test } from 'node:test'

import { API_PREFIX, createPluginRoute } from '../host/route.js'
import { DEFAULTS, toClientConfig } from '../host/config.js'

/** Minimal ServerResponse double: records status, headers, and the JSON body. */
function fakeResponse() {
  const state = { status: 0, headers: {}, body: '' }
  const res = {
    headersSent: false,
    setHeader(name, value) { state.headers[name.toLowerCase()] = value },
    writeHead(status, headers) {
      state.status = status
      state.headersSent = true
      Object.assign(state.headers, headers ?? {})
    },
    end(body) { state.body = body ?? '' },
  }
  return { res, state }
}

/** Dispatch one request; malformed request URLs are reachable on purpose. */
async function call(route, method, url) {
  const { res, state } = fakeResponse()
  await route({ method, url }, res)
  let json = null
  try { json = JSON.parse(state.body) } catch (_notJson) { json = null }
  return { state, json }
}

const route = createPluginRoute({ config: toClientConfig({}), version: '9.9.9' })

test('GET /config publishes the normalized switches without caching', async () => {
  const { state, json } = await call(route, 'GET', `${API_PREFIX}/config`)
  assert.equal(state.status, 200)
  assert.equal(state.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(state.headers['cache-control'], 'no-store')
  assert.equal(state.headers['x-content-type-options'], 'nosniff')
  assert.deepEqual(json, { version: '9.9.9', config: DEFAULTS })
})

test('HEAD is accepted and answers the same headers', async () => {
  const { state } = await call(route, 'HEAD', `${API_PREFIX}/config`)
  assert.equal(state.status, 200)
  assert.equal(state.headers['cache-control'], 'no-store')
})

test('GET /health reports liveness and version', async () => {
  const { state, json } = await call(route, 'GET', `${API_PREFIX}/health`)
  assert.equal(state.status, 200)
  assert.deepEqual(json, { ok: true, name: 'better-markdown', version: '9.9.9' })
})

test('unknown child paths answer a JSON 404 instead of the SPA', async () => {
  const { state, json } = await call(route, 'GET', `${API_PREFIX}/nope`)
  assert.equal(state.status, 404)
  assert.equal(json.error.code, 'not-found')
})

test('non-read methods are refused with 405 and an Allow header', async () => {
  const { state, json } = await call(route, 'POST', `${API_PREFIX}/config`)
  assert.equal(state.status, 405)
  assert.equal(state.headers.allow, 'GET, HEAD')
  assert.equal(json.error.code, 'method-not-allowed')
})

test('an unparsable request URL answers 400', async () => {
  const { state, json } = await call(route, 'GET', 'http://[bad')
  assert.equal(state.status, 400)
  assert.equal(json.error.code, 'bad-request')
})

test('the route never echoes request data', async () => {
  const { state, json } = await call(route, 'GET', `${API_PREFIX}/config?token=secret`)
  assert.equal(state.status, 200)
  assert.ok(!state.body.includes('secret'))
  assert.deepEqual(Object.keys(json).sort(), ['config', 'version'])
})
