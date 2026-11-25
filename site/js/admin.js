// The steward's page. Everything from the request form is shown as text (T.el builds text nodes).
(function () {
  const { el, table } = T
  const $ = (id) => document.getElementById(id)
  const say = (t, bad = false) => { $('status').textContent = t || ''; $('status').classList.toggle('bad', bad) }
  const SITE = location.origin

  async function api(path, body) {
    const res = await fetch('/api/admin/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || "That didn't work.")
    return data
  }

  function mailto(email, name, code, uses) {
    const body = `${name ? `Hi ${name},\n\n` : ''}Here's your invite to autonomist's chat:\n\n${code}\n\nEnter it at ${SITE}/chat/ . It works in up to ${uses} browsers.\n\nautonomist is a public-interest project: it sells nothing, and nothing it says is investment, legal or financial advice. The chat is an AI and can be wrong.\n`
    return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent('Your invite to autonomist')}&body=${encodeURIComponent(body)}`
  }

  function showCode(code, uses, email, name) {
    const box = $('minted')
    const copy = el('button', { type: 'button', class: 'secondary' }, 'Copy')
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(code); copy.textContent = 'Copied' } catch { copy.textContent = 'Select and copy it' } })
    box.replaceChildren(
      el('p', {}, el('strong', {}, code), ` works in ${uses} browser${uses > 1 ? 's' : ''}. It is shown once; it's stored only as a hash.`),
      el('p', {}, copy, ' ', email ? el('a', { href: mailto(email, name, code, uses) }, `Email it to ${email}`) : ''),
    )
    box.hidden = false
    box.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  async function load() {
    const s = await api('state')
    $('who').textContent = `Signed in through Cloudflare Access as ${s.steward}.`
    $('requests').replaceChildren(...(s.requests.length ? s.requests.map((r) => {
      const invite = el('button', { type: 'button' }, 'Invite')
      const remove = el('button', { type: 'button', class: 'secondary' }, 'Remove')
      invite.addEventListener('click', async () => {
        if (!confirm(`Make an invite for ${r.email}? They come off the request list.`)) return
        try { const out = await api('request/invite', { id: r.id }); showCode(out.code, out.uses, out.email, out.name); load() } catch (e) { say(e.message, true) }
      })
      remove.addEventListener('click', async () => {
        if (!confirm(`Remove ${r.email} without an invite?`)) return
        try { await api('request/remove', { id: r.id }); load() } catch (e) { say(e.message, true) }
      })
      return el('li', {}, el('strong', {}, r.email), el('p', {}, [r.name, r.org].filter(Boolean).join(' · ')), r.note ? el('p', {}, r.note) : '', el('p', { class: 'muted' }, `asked ${String(r.at || '').slice(0, 10)}`), el('p', {}, invite, ' ', remove))
    }) : [el('li', {}, el('p', {}, 'Nobody is waiting.'))]))
    $('invites').replaceChildren(s.invites.length ? table(['Label', 'Browsers used', 'Made', ''], s.invites.map((i) => {
      const b = el('button', { type: 'button', class: 'secondary' }, 'Revoke')
      b.addEventListener('click', async () => { if (!confirm(`Revoke "${i.label}"? It stops working everywhere, and its conversation is erased.`)) return; try { await api('revoke', { hash: i.hash }); load() } catch (e) { say(e.message, true) } })
      return [i.label || '(no label)', `${i.used} of ${i.max_uses ?? '∞'}`, i.created, b]
    })) : el('p', { class: 'muted' }, 'No invites yet.'))
    $('proposals').replaceChildren(...(s.proposals.length ? s.proposals.map((p) => {
      const del = el('button', { type: 'button', class: 'secondary' }, 'Delete')
      del.addEventListener('click', async () => { if (!confirm('Delete this proposal?')) return; try { await api('proposal/delete', { id: p.id }); load() } catch (e) { say(e.message, true) } })
      return el('div', { class: 'note' }, el('h3', {}, p.title), el('p', {}, p.summary), el('p', { class: 'muted' }, 'Sources (check each before publishing):'), el('ul', {}, (p.sources || []).map((u) => el('li', {}, u))), el('p', { class: 'muted' }, String(p.created || '').slice(0, 10)), del)
    }) : [el('p', { class: 'muted' }, 'None.')]))
  }

  // dry runs: the recent ones, each with its pages, its posts and its steps
  async function loadDry() {
    const d = await api('dry-runs')
    const head = d.running ? 'A dry run is running now.' : d.requested ? `A dry run of ${d.requested.what} is waiting for the next five-minute run.` : ''
    const items = await Promise.all(d.index.slice(0, 8).map(async (x) => {
      const a = await api(`dry-run/${x.id}`).catch(() => null)
      if (!a) return null
      const pages = (a.pages || []).map((rkey) => el('li', {}, el('a', { href: `/api/admin/dry-run/${x.id}/page/${rkey}`, target: '_blank', rel: 'noopener' }, rkey)))
      const posts = (a.posts || []).map((p) => el('li', {}, el('p', {}, p.text), p.card ? el('p', { class: 'muted' }, `card: ${p.card.uri}`) : ''))
      const steps = (a.steps || []).map((s) => el('li', {}, `${s.ok ? '' : 'FAILED '}${s.name}: ${s.ok ? JSON.stringify(s.result) : s.error} (${Math.round(s.ms / 1000)}s)`))
      return el('div', { class: 'note' },
        el('h3', {}, `${String(a.at).replace('T', ' ').slice(0, 16)} UTC · ${a.what.join(', ')}`),
        el('p', { class: 'muted' }, `${Math.round(a.ms / 1000)}s · $${a.spend} · ${a.posts.length} posts and ${a.writes.length} records captured, none sent`),
        pages.length ? el('p', {}, 'Pages it would have published:') : '', pages.length ? el('ul', {}, pages) : '',
        posts.length ? el('p', {}, 'Posts it would have made:') : '', posts.length ? el('ul', {}, posts) : '',
        el('details', {}, el('summary', {}, 'Steps'), el('ul', {}, steps)),
        el('p', {}, el('a', { href: `/api/admin/dry-run/${x.id}`, target: '_blank', rel: 'noopener' }, 'Everything, as JSON')))
    }))
    const shown = items.filter(Boolean)
    $('dryruns').replaceChildren(...[head ? el('p', {}, head) : '', ...(shown.length ? shown : [el('p', { class: 'muted' }, 'No dry runs yet.')])])
  }
  for (const [id, what] of [['dry-digest', 'digest,questions'], ['dry-all', 'all']]) {
    $(id).addEventListener('click', async () => { try { const out = await api('dry-run', { what }); say(out.note); loadDry() } catch (e) { say(e.message, true) } })
  }

  function showPanel() { $('panel').hidden = false; loadDry().catch((e) => say(e.message, true)) }
  $('mint').addEventListener('submit', async (e) => {
    e.preventDefault()
    try { const out = await api('invite', { label: e.target.label.value, uses: e.target.uses.value }); showCode(out.code, out.uses); e.target.reset(); load() } catch (err) { say(err.message, true) }
  })
  load().then(showPanel).catch((e) => say(e.message, true))
})()
