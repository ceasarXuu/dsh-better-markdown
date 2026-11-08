import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULTS, toClientConfig } from '../host/config.js'

test('defaults are the documented all-on shape', () => {
  assert.deepEqual(DEFAULTS, {
    enabled: true,
    transcript: true,
    composer: true,
    syntax: true,
    preview: true,
  })
  assert.ok(Object.isFrozen(DEFAULTS))
})

test('an empty or absent config normalizes to the defaults', () => {
  assert.deepEqual(toClientConfig(undefined), DEFAULTS)
  assert.deepEqual(toClientConfig(null), DEFAULTS)
  assert.deepEqual(toClientConfig({}), DEFAULTS)
  assert.deepEqual(toClientConfig('not-an-object'), DEFAULTS)
})

test('booleans win, wrong types fall back per field, unknown keys drop', () => {
  const folded = toClientConfig({
    enabled: false,
    transcript: 'yes',
    composer: 1,
    syntax: null,
    preview: false,
    extra: true,
  })
  assert.deepEqual(folded, {
    enabled: false,
    transcript: true,
    composer: true,
    syntax: true,
    preview: false,
  })
  assert.ok(!('extra' in folded))
  assert.ok(Object.isFrozen(folded))
})

test('the normalized value cannot be mutated after the fact', () => {
  const folded = toClientConfig({ preview: false })
  assert.throws(() => { folded.preview = true }, TypeError)
})
