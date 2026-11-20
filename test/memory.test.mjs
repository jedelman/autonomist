import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker, { deps } from '../worker/index.js'
import { foldPlan, contextWindow, exportMarkdown } from '../worker/thread.js'
import { foldMemory } from '../worker/memory.js'
import { newCode, inviteKey } from '../worker/invites.js'
import { memoryKV, assets } from './helpers.mjs'

const turn = (role, n, ch = 'x') => ({ role, content: ch.repeat(n) })
const usage = { input_tokens: 2000, output_tokens: 300 }

test('foldPlan waits for the budget, then folds the oldest to half, ending before a question', () => {
  const small = { turns: [turn('user', 10), turn('assistant', 10)], memory: null }
  assert.equal(foldPlan(small, 100), null)
  const t = { turns: [turn('user', 30), turn('assistant', 30), turn('user', 30), turn('assistant', 30), turn('user', 30), turn('assistant', 30)], memory: null }
  const plan = foldPlan(t, 100)
  assert.deepEqual(plan, { from: 0, to: 4 })
  assert.equal(t.turns[plan.to].role, 'user')
  assert.equal(foldPlan({ ...t, memory: { text: 'm', through: 4 } }, 100), null)
})

test('the memory rides inside the first question, and only later turns follow it', () => {
  const t = { turns: [turn('user', 5, 'a'), turn('assistant', 5, 'b'), turn('user', 5, 'c'), turn('assistant', 5, 'd')], memory: { text: 'REMEMBERED', through: 2 } }
  const m = contextWindow(t, 'now', 1000)
  assert.equal(m.length, 3)
  assert.equal(m[0].role, 'user')
  assert.match(m[0].content, /<earlier_conversation_memory>[\s\S]*REMEMBERED[\s\S]*<\/earlier_conversation_memory>\s+ccccc$/)
  assert.ok(!m.some((x) => x.content.includes('aaaaa')))
  assert.equal(m[2].content, 'now')
})

test('foldMemory sends the memory and the leaving turns, prices the call, and caps the length', async () => {
  let sent
  const create = async (p) => { sent = p; return { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'y '.repeat(8000) }] } }
  const out = await foldMemory({ memory: 'OLD', turns: [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }], create })
  assert.match(sent.messages[0].content, /<memory_so_far>\nOLD/)
  assert.match(sent.messages[0].content, /Person: Q1\n\nautonomist: A1/)
  assert.ok(out.cost > 0)
  assert.ok(out.text.length <= 9002)
  const refused = await foldMemory({ memory: '', turns: [], create: async () => ({ stop_reason: 'refusal', usage, content: [] }) })
  assert.equal(refused.text, null)
})

test('a long conversation folds into memory after the answer, and the next question carries it', async () => {
  const O = 'https://autonomist.test'
  const env = { KV: memoryKV(), ASSETS: assets, INVITE_SECRET: 's'.repeat(32), IP_SALT: 'salt', ANTHROPIC_API_KEY: 'k', PUBLIC_ORIGIN: O, HISTORY_CHARS: '6000' }
  const pending = []
  const ctx = { waitUntil: (p) => pending.push(p) }
  const post = (path, body, cookie) => worker.fetch(new Request(O + path, { method: 'POST', headers: { Origin: O, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }), env, ctx)
  const code = newCode()
  await env.KV.put(await inviteKey(code), JSON.stringify({ label: 't' }))
  const cookie = (await post('/api/invite', { code })).headers.get('Set-Cookie').split(';')[0]
  const hash = (await inviteKey(code)).slice(7)
  const seen = []
  const realAsk = deps.ask, realFold = deps.fold
  let folds = 0
  deps.ask = async ({ messages }) => { seen.push(messages); return { answer: 'A'.repeat(1500), sources: [], results: [], tools: [], cost: 0 } }
  deps.fold = async ({ turns }) => { folds++; return { text: `MEMORY of ${turns.length} turns`, cost: 0.0001 } }
  try {
    for (let i = 0; i < 4; i++) { assert.equal((await post('/api/chat', { question: `question ${i}` }, cookie)).status, 200); await Promise.all(pending.splice(0)) }
    const stored = await env.KV.get(`thread:${hash}`, 'json')
    assert.equal(folds, 1)
    assert.equal(stored.memory.text.startsWith('MEMORY of'), true)
    assert.equal(stored.turns.length, 8)
    assert.equal((await post('/api/chat', { question: 'question 4' }, cookie)).status, 200)
    const last = seen.at(-1)
    assert.match(last[0].content, /MEMORY of/)
    assert.ok(!last.some((m) => m.content.includes('question 0')))
    const shown = await (await worker.fetch(new Request(O + '/api/thread', { headers: { Cookie: cookie } }), env, ctx)).json()
    assert.equal(shown.turns.length, 10)
    assert.match(shown.memory.text, /MEMORY of/)
    const file = await worker.fetch(new Request(O + '/api/thread?export', { headers: { Cookie: cookie } }), env, ctx)
    assert.match(file.headers.get('Content-Disposition'), /attachment/)
    const md = await file.text()
    assert.match(md, /What autonomist remembers from earlier/)
    assert.match(md, /question 0/)
  } finally { deps.ask = realAsk; deps.fold = realFold }
})

test('the export spells out links in full', () => {
  const md = exportMarkdown({ turns: [{ role: 'assistant', content: 'hi', sources: [{ url: '/tools/', title: 'Tools' }] }], memory: null }, 'https://a.test')
  assert.match(md, /- Tools: https:\/\/a\.test\/tools\//)
})
