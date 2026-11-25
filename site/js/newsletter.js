// The digest by email (worker/newsletter.js): the sign-up form on /newsletter/, and the Confirm button on
// /newsletter/confirm/. The confirmation token is in the link's #fragment, so it never reaches a server until
// Confirm is pressed, and is cleared from the address bar once read.
const $ = (id) => document.getElementById(id)
const say = (el, text, bad = false) => { el.textContent = text || ''; el.classList.toggle('bad', bad) }

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  return { res, data }
}

const signup = $('signup')
if (signup) {
  const status = $('signup-status')
  fetch('/api/newsletter').then((r) => r.json()).then((s) => {
    if (s.open) signup.hidden = false
    else say(status, "The digest by email isn't open yet. Until it is, every digest is on the journal.")
  }).catch(() => say(status, "Couldn't reach the server. Reload to try again.", true))
  signup.addEventListener('submit', async (e) => {
    e.preventDefault()
    const button = signup.querySelector('button')
    button.disabled = true
    try {
      const { res, data } = await post('/api/newsletter/subscribe', { email: signup.email.value, website: signup.website.value })
      if (!res.ok) return say(status, data.error || "That didn't work.", true)
      signup.hidden = true
      say(status, data.note || 'Check your email for a link to confirm.')
    } catch { say(status, "Couldn't reach the server. Try again.", true) } finally { button.disabled = false }
  })
}

const box = $('confirm')
if (box) {
  const status = $('confirm-status')
  const token = new URLSearchParams(location.hash.slice(1)).get('t')
  if (token) history.replaceState(null, '', location.pathname)
  if (!token) say(status, "This link isn't complete. Open it again from the email, or sign up again on the newsletter page.", true)
  else {
    say(status, '')
    box.hidden = false
    $('confirm-button').addEventListener('click', async (e) => {
      e.target.disabled = true
      try {
        const { res, data } = await post('/api/newsletter/confirm', { token })
        if (!res.ok) { e.target.disabled = false; return say(status, data.error || "That didn't work.", true) }
        box.hidden = true
        say(status, data.note || "You're subscribed.")
      } catch { e.target.disabled = false; say(status, "Couldn't reach the server. Try again.", true) }
    })
  }
}
