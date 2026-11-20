// The chat page: the invite gate, "Request access", and the conversation. The conversation lives
// only in this tab. Answers render through md.js, which escapes everything; a link survives only
// if it points at this site, Power Explained, the project's source, or a source the server says
// this answer used.
import { render, esc } from './md.js'

const $ = (id) => document.getElementById(id)
const status = (t, bad = false) => { $('status').textContent = t || ''; $('status').classList.toggle('bad', bad) }
const turns = []

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  return { res, data }
}

function showChat() { $('gate').hidden = true; $('chat').hidden = false; $('composer').q.focus() }
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

function addMessage(role, text, extra = {}) {
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
  div.scrollIntoView({ block: 'end', behavior: 'smooth' })
}

async function askQ(q) {
  q = q.trim()
  if (!q) return
  $('examples').hidden = true
  addMessage('user', q)
  turns.push({ role: 'user', content: q })
  const btn = $('composer').querySelector('button')
  btn.disabled = true
  status('Working it out…')
  try {
    const { res, data } = await post('/api/chat', { messages: turns.slice(-9) })
    if (res.status === 401 && data.gate) { turns.pop(); status(data.error, true); return showGate() }
    if (!res.ok) { turns.pop(); return status(data.error || 'Something went wrong.', true) }
    turns.push({ role: 'assistant', content: data.answer })
    addMessage('assistant', data.answer, data)
    status('')
  } catch {
    turns.pop()
    status("Couldn't reach the server. Try again.", true)
  } finally { btn.disabled = false }
}

$('composer').addEventListener('submit', (e) => { e.preventDefault(); const q = e.target.q.value; e.target.q.value = ''; askQ(q) })
$('composer').q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit() } })
for (const b of $('examples').querySelectorAll('button')) b.addEventListener('click', () => askQ(b.textContent))
init()
