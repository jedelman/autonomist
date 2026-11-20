import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ask } from '../worker/agent.js'
import { cleanTitle } from '../worker/tools.js'
import { memoryKV } from './helpers.mjs'

const usage = { input_tokens: 1000, output_tokens: 100 }

test('runs tools, records a saved result computed by code, and prices every call', async () => {
  const kv = memoryKV()
  let calls = 0, spent = 0
  const create = async (p) => {
    calls++
    assert.equal(p.model, 'claude-haiku-5-5')
    assert.equal(p.system[0].cache_control.type, 'ephemeral')
    if (calls === 1) return { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 'a', name: 'save_result', input: { title: 'Eight homes', tool: 'underwrite_building', inputs: { units: 8, price: 2400000, cap_rate: 0.0627, repairs: 40000 } } }] }
    return { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Saved.' }] }
  }
  const out = await ask({ messages: [{ role: 'user', content: 'save it' }], create, kv, onCost: (u) => { spent += u } })
  assert.equal(out.answer, 'Saved.')
  assert.equal(out.results.length, 1)
  const rec = JSON.parse(kv.m.get(`result:${out.results[0].id}`).v)
  assert.equal(rec.outputs.stacks.commons.dscr, 1.24)
  assert.ok(spent > 0)
})

test('a refusal ends the turn plainly', async () => {
  const out = await ask({ messages: [{ role: 'user', content: 'x' }], create: async () => ({ stop_reason: 'refusal', usage, content: [] }) })
  assert.equal(out.refused, true)
})

test('tool errors go back to the model as errors; the last step forbids tools', async () => {
  let seen
  const create = async (p) => {
    if (p.tool_choice?.type === 'none') return { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'done' }] }
    seen = p.messages.at(-1)
    return { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 'b', name: 'save_result', input: { title: 'call 757-555-0100', tool: 'underwrite_building', inputs: {} } }] }
  }
  const out = await ask({ messages: [{ role: 'user', content: 'x' }], create, kv: memoryKV(), maxSteps: 3 })
  assert.equal(out.answer, 'done')
  assert.equal(seen.content[0].is_error, true)
})

test('titles with links, emails or phone numbers are refused', () => {
  assert.equal(cleanTitle('See https://x.example'), null)
  assert.equal(cleanTitle('a@b.org'), null)
  assert.equal(cleanTitle('757-555-0100'), null)
  assert.equal(cleanTitle('  Eight homes at a 6.27% cap  '), 'Eight homes at a 6.27% cap')
})
