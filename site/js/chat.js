// The chat page: the invite gate, "Request access", and the person's one conversation, kept on the
// server under their invite (thread.js) and loaded whenever the page opens, on any of their
// browsers. Answers render through md.js, which escapes everything; a link survives only if it
// points at this site, Power Explained, the project's source, or a source the server says that
// answer used.
import { render, esc } from './md.js'

const $ = (id) => document.getElementById(id)
const status = (t, bad = false) => { $('status').textContent = t || ''; $('status').classList.toggle('bad', bad) }

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  return { res, data }
}

async function showChat() {
  $('gate').hidden = true
  $('chat').hidden = false
  try {
    const r = await fetch('/api/thread', { cache: 'no-store' })
    const data = await r.json()
    if (r.status === 401) return showGate()
    $('log').replaceChildren()
    showMemory(data.memory)
    for (const t of data.turns || []) addMessage(t.role, t.content, t, false)
    $('examples').hidden = (data.turns || []).length > 0
    $('erase-row').hidden = !(data.turns || []).length
    const last = $('log').lastElementChild
    if (last) last.scrollIntoView({ block: 'end' })
  } catch { status("Couldn't load your conversation. Reload to try again.", true) }
  $('composer').q.focus()
}
function showGate() { $('gate').hidden = false; $('chat').hidden = true }

async function init() {
  try {
    const r = await fetch('/api/session', { cache: 'no-store' })
    const s = await r.json()
    if (!s.ready) return status(s.setup || 'The chat is not open yet.', true)
    s.invited ? showChat() : showGate()
  } catch { status("Couldn't reach the server. Try again.", true) }
}

$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  status('Checking…')
  const { res, data } = await post('/api/invite', { code: e.target.code.value })
  if (!res.ok) return status(data.error || "That didn't work.", true)
  status('')
  showChat()
})
$('show-access').addEventListener('click', () => { $('access').hidden = false; $('access').email.focus() })
$('access').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = e.target
  const { res, data } = await post('/api/request-access', { email: f.email.value, name: f.name.value, org: f.org.value, note: f.note.value, website: f.website.value })
  if (!res.ok) return status(data.error || "That didn't work.", true)
  f.replaceChildren(Object.assign(document.createElement('p'), { textContent: "Thanks. You're on the list; an invite will come by email." }))
  status('')
})

const ALLOWED = [/^\/(?!\/)/, /^#[\w-]+$/, /^https:\/\/power-explained\.jason-edelman\.org(\/|$)/, /^https:\/\/github\.com\/jedelman\/autonomist(\/|$)/]

// The memory is model-written: shown as plain text, never as markup or links.
function showMemory(memory) {
  $('memory').hidden = !memory?.text
  $('memory-text').textContent = memory?.text || ''
}

function addMessage(role, text, extra = {}, scroll = true) {
  const div = document.createElement('div')
  div.className = `msg ${role}`
  if (role === 'user') div.textContent = text
  else {
    const sources = new Set((extra.sources || []).map((s) => s.url))
    div.innerHTML = render(text, { allowLink: (u) => sources.has(u) || ALLOWED.some((re) => re.test(u)), headingIds: false })
    if (extra.sources?.length) {
      const s = document.createElement('div')
      s.className = 'sources'
      s.innerHTML = 'Sources and saved results:<ul>' + extra.sources.map((x) => `<li><a href="${esc(x.url)}"${/^https:/.test(x.url) ? ' rel="noopener noreferrer"' : ''}>${esc(x.title)}</a></li>`).join('') + '</ul>'
      div.append(s)
    }
  }
  $('log').append(div)
  if (scroll) div.scrollIntoView({ block: 'end', behavior: 'smooth' })
}

async function askQ(q) {
  q = q.trim()
  if (!q) return
  $('examples').hidden = true
  addMessage('user', q)
  const btn = $('composer').querySelector('button')
  btn.disabled = true
  status('Working it out…')
  const giveBack = () => { $('log').lastElementChild?.remove(); $('composer').q.value = q }
  try {
    const { res, data } = await post('/api/chat', { question: q })
    if (res.status === 401 && data.gate) { giveBack(); status(data.error, true); return showGate() }
    if (!res.ok) { giveBack(); return status(data.error || 'Something went wrong.', true) }
    addMessage('assistant', data.answer, data)
    $('erase-row').hidden = false
    status('')
  } catch {
    giveBack()
    status("Couldn't reach the server. Try again.", true)
  } finally { btn.disabled = false }
}

$('composer').addEventListener('submit', (e) => { e.preventDefault(); const q = e.target.q.value; e.target.q.value = ''; askQ(q) })
$('composer').q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit() } })
for (const b of $('examples').querySelectorAll('button')) b.addEventListener('click', () => askQ(b.textContent))
$('erase').addEventListener('click', async () => {
  if (!confirm('Erase your whole conversation and what autonomist remembers of it? It is deleted for good, on every browser using your invite. You can download it first.')) return
  const { res, data } = await post('/api/thread/erase', {})
  if (!res.ok) return status(data.error || "That didn't work.", true)
  $('log').replaceChildren()
  showMemory(null)
  $('examples').hidden = false
  $('erase-row').hidden = true
  status('Erased.')
})
init()
