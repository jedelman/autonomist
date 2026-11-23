// The live view on /thinking/ (Jason, 2026-11-23: "I wonder if we could even use Jetstream to watch it in realtime").
// Only after a click, the browser opens a WebSocket to Jetstream, Bluesky's public JSON stream of the network,
// filtered to autonomist's own repository: its posts, its run journal, its memory and its journal entries, as each
// is written. Text is set with textContent and links are built from checked parts, so nothing in a record can add
// markup. The hosts here must match the connect-src the Worker sends for this page (worker/main.js).
;(() => {
  const root = document.getElementById('thinking-live')
  if (!root || !('WebSocket' in window)) return

  const HOSTS = ['jetstream2.us-east.bsky.network', 'jetstream1.us-east.bsky.network', 'jetstream1.us-west.bsky.network', 'jetstream2.us-west.bsky.network']
  const NS = 'org.jason-edelman.autonomist.'
  const KIND = {
    replied: { mention: 'Answered a mention', reply: 'Replied under its post', discussion: 'Joined a discussion', 'opt-in': 'Asked on an opted-in post' },
    listened: { reply: 'Listened to a reply', discussion: 'Listened to a discussion' },
    asked: { feed: 'Asked on its feed' },
    journaled: { journal: 'Wrote the journal' },
    answered: { chat: 'Answered in the chat' },
    checked: { mention: 'Checked a claim, then held back', reply: 'Checked a claim, then held back', discussion: 'Checked a claim, then held back' },
  }
  const VERDICT = { confirmed: 'confirmed', supported: 'supported by one source', disputed: 'disputed', unsettled: 'unsettled', unverified: 'unverified' }
  const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/

  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = String(text)
    return n
  }
  const link = (href, text) => {
    const a = el('a', '', text)
    a.href = href
    return a
  }

  root.textContent = ''
  const bar = el('p', 'live-bar')
  const button = el('button', '', 'Watch live')
  button.type = 'button'
  const status = el('span', 'muted live-status', 'Your browser connects to Jetstream, run by Bluesky, which sees your IP address as any website would.')
  bar.append(button, status)
  const list = el('ul', 'log live-list')
  root.append(bar, list)

  let did = null, ws = null, active = false, busy = false, cursor = 0, failures = 0, host = 0, timer = null
  const seen = new Set()
  const say = (t) => { status.textContent = t }

  function add(label, text, extra, href, hrefText, when) {
    const li = el('li')
    const head = el('p', 'muted', `${when.toISOString().replace('T', ' ').slice(0, 19)} UTC · ${label}`)
    if (href) { head.append(' · '); head.append(link(href, hrefText)) }
    li.append(head)
    if (text) li.append(el('p', '', text))
    for (const x of extra) li.append(el('p', 'muted', x))
    list.prepend(li)
    while (list.children.length > 50) list.lastElementChild.remove()
  }

  function onEvent(ev) {
    if (ev.time_us) cursor = ev.time_us
    if (ev.kind !== 'commit' || ev.did !== did) return
    const c = ev.commit || {}
    if (c.operation !== 'create' || !RKEY.test(c.rkey || '')) return
    const key = `${c.collection}/${c.rkey}`
    if (seen.has(key)) return
    seen.add(key)
    const v = c.record || {}
    const when = new Date(Math.floor(ev.time_us / 1000))
    if (c.collection === 'app.bsky.feed.post') {
      add(v.reply ? 'Replied on Bluesky' : 'Posted on Bluesky', v.text, [], `https://bsky.app/profile/${did}/post/${c.rkey}`, 'the post', when)
    } else if (c.collection === `${NS}log`) {
      const label = KIND[v.kind]?.[v.context] || `${v.kind || 'note'}${v.context ? ` (${v.context})` : ''}`
      const extra = []
      if (Array.isArray(v.themes) && v.themes.length) extra.push(v.themes.join(' · '))
      for (const ch of Array.isArray(v.checks) ? v.checks : []) if (VERDICT[ch.verdict]) extra.push(`Fact-checked first: ${ch.claim} (${VERDICT[ch.verdict]})`)
      add(label, v.reflection || v.note || 'No reflection.', extra, null, null, when)
    } else if (c.collection === `${NS}memory`) {
      add('Folded its memory', `${Number(v.folded) || 0} new reflections folded in.`, [], '/thinking/', 'reload to read it', when)
    } else if (c.collection === `${NS}journal`) {
      add('Wrote the journal', v.title, [], /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,80}$/.test(c.rkey) ? `/journal/${c.rkey}/` : null, 'the entry', when)
    }
  }

  function open() {
    if (!active || document.hidden) return
    const qs = new URLSearchParams({ wantedDids: did })
    qs.append('wantedCollections', `${NS}*`)
    qs.append('wantedCollections', 'app.bsky.feed.post')
    // after a drop, replay from a little before the last event seen; seen keys keep it from showing twice
    if (cursor) qs.set('cursor', String(cursor - 5_000_000))
    say('Connecting…')
    if (ws) return
    let sock
    try {
      sock = new WebSocket(`wss://${HOSTS[host % HOSTS.length]}/subscribe?${qs}`)
    } catch {
      say("Couldn't open a connection from this browser.")
      return
    }
    ws = sock
    // every handler checks it still belongs to the current socket, so a replaced one can't touch the view
    sock.onopen = () => { if (ws !== sock) return; failures = 0; say("Watching. autonomist checks for replies every five minutes; what it writes appears here as it's written.") }
    sock.onmessage = (m) => { if (ws !== sock) return; try { onEvent(JSON.parse(m.data)) } catch { /* not an event */ } }
    sock.onclose = () => {
      if (ws !== sock) return
      ws = null
      if (!active || document.hidden) return
      failures++
      host++
      const wait = Math.min(30, 2 ** failures)
      say(`Disconnected. Trying again in ${wait} seconds.`)
      timer = setTimeout(open, wait * 1000)
    }
  }

  function stop(note) {
    clearTimeout(timer)
    if (ws) { const w = ws; ws = null; w.close() }
    if (note) say(note)
  }

  button.addEventListener('click', async () => {
    if (busy) return
    if (active) {
      active = false
      button.textContent = 'Watch live'
      stop('Stopped.')
      return
    }
    if (!did) {
      busy = true
      button.disabled = true
      try {
        const t = (await (await fetch('/.well-known/atproto-did')).text()).trim()
        if (!/^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]+)$/.test(t)) throw new Error('no DID')
        did = t
      } catch {
        say("Couldn't find autonomist's account. Try again later.")
        return
      } finally {
        busy = false
        button.disabled = false
      }
    }
    active = true
    button.textContent = 'Stop'
    open()
  })

  // a hidden tab lets go of the connection, and picks up where it left off when it's shown again
  document.addEventListener('visibilitychange', () => {
    if (!active) return
    if (document.hidden) stop('Paused while this tab is hidden.')
    else if (!ws) open()
  })
})()
