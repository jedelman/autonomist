// Adapted from Siren's worker/access.js (github.com/jedelman/socrata-agent, MIT, the same author).
// Cloudflare Access identity, for the steward's page. Access sits in front of /admin and
// /api/admin; the Worker still verifies the signed token on every request, against the team's
// public keys, so a gap in the Access policy or the workers.dev address can't get around it. The
// plain Cf-Access-Authenticated-User-Email header is never trusted on its own.

const CERT_TTL_MS = 60 * 60 * 1000;
let certCache = { team: null, at: 0, keys: [] };

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const json = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

async function teamKeys(team, fetchImpl, { fresh = false } = {}) {
  if (!fresh && certCache.team === team && Date.now() - certCache.at < CERT_TTL_MS) return certCache.keys;
  const res = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const { keys = [] } = await res.json();
  certCache = { team, at: Date.now(), keys };
  return keys;
}

export function resetAccessCache() {
  certCache = { team: null, at: 0, keys: [] };
}

/** Returns { email } for a valid token, or throws with the reason. */
export async function verifyAccess(req, env, fetchImpl = fetch) {
  const team = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  const token = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new Error('missing Access token');
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) throw new Error('malformed token');
  const header = json(h);
  const payload = json(p);
  if (header.alg !== 'RS256') throw new Error('unexpected algorithm');
  // An unknown key id usually means Cloudflare rotated keys: re-fetch once
  // rather than refusing everyone until the cache expires.
  let jwk = (await teamKeys(team, fetchImpl)).find((k) => k.kid === header.kid);
  // At most once a minute, so made-up key ids can't force a fetch per request.
  if (!jwk && Date.now() - certCache.at > 60_000) jwk = (await teamKeys(team, fetchImpl, { fresh: true })).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('token expired');
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) throw new Error('token not yet valid');
  if (payload.iss !== `https://${team}`) throw new Error('wrong issuer');
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new Error('wrong audience');
  if (!payload.email) throw new Error('token has no email');
  return { email: String(payload.email).toLowerCase() };
}
