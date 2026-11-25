// The Power Explained passages autonomist may quote in its journal and replies. Each is verbatim from a public page
// (checked live by `node scripts/journal-check.mjs --framework`). The reading may go beyond them, but only these
// may appear in curly quotes, and the entry must say when it is inferring rather than quoting.
const PE = 'https://power-explained.jason-edelman.org'

export const FRAMEWORK = [
  { url: `${PE}/start-here`, page: 'Start Here', text: 'Every system that extracts value from communities depends on a productive substrate — shared resources, shared labor, shared knowledge, shared trust — that it cannot produce itself.' },
  { url: `${PE}/start-here`, page: 'Start Here', text: 'A system of extraction routes value from that shared thing through private ownership or state control before it reaches the people who built it.' },
  { url: `${PE}/start-here`, page: 'Start Here', text: "the main barrier to building more of them is not human nature or economic law — it's a set of institutional arrangements and the stories told to make them seem permanent." },
  { url: `${PE}/build-it-now`, page: 'Build It Now', text: "It's held in place by the absence of functioning alternatives." },
  { url: `${PE}/build-it-now`, page: 'Build It Now', text: 'Every institution that builds a genuine alternative — that actually routes care, resources, or security through something other than the market or the state — makes the existing system slightly less necessary and therefore slightly less stable.' },
  { url: `${PE}/build-it-now`, page: 'Build It Now', text: "It needs to connect to other forms of power — labor organizing, electoral fights where they're winnable, legal challenges, direct action." },
  { url: `${PE}/hardin-was-wrong`, page: 'Hardin Gave Capitalism Its Alibi. Ostrom Took It Apart.', text: 'The solution, Hardin said, was either private ownership or state control.' },
  { url: `${PE}/hardin-was-wrong`, page: 'Hardin Gave Capitalism Its Alibi. Ostrom Took It Apart.', text: 'They were governed by the people who used them, through rules those people had made themselves, enforced by those same communities.' },
  { url: `${PE}/env-carbon-markets-are-enclosures`, page: 'Carbon Markets Are the New Enclosures', text: 'You get enclosure: the conversion of shared commons — the carbon cycle, standing forests, the living systems Indigenous communities govern — into tradeable assets controlled by whoever structures the deal first.' },
  { url: `${PE}/freire`, page: 'Paulo Freire', text: 'If the banking model deposits knowledge from above, the alternative is dialogue — a relationship in which both teacher and student are simultaneously learners.' },
  { url: `${PE}/care-is-the-economy`, page: 'Care Is the Economy', text: 'The economy runs on care. Capitalism cannot exist without it.' },
  { url: `${PE}/care-is-the-economy`, page: 'Care Is the Economy', text: 'Capitalism enclosed care.' },
  { url: `${PE}/land-is-the-foundation`, page: 'Land Is the Foundation', text: 'Land can be held in trust. Governed collectively. Managed for the benefit of the people who live on it, the generations that will come after, and the non-human life that depends on it.' },
  { url: `${PE}/land-is-the-foundation`, page: 'Land Is the Foundation', text: 'The enclosure of common lands in England was not about efficiency. It was about control.' },
  { url: `${PE}/land-is-the-foundation`, page: 'Land Is the Foundation', text: 'Land that could feed a community is held by investors who have never set foot on it.' },
]

/**
 * The passages as a numbered sheet. Passages used recently (`used`, newest first, from KV framework:used) go last and
 * are marked, so the writing doesn't lean on the same two lines every day.
 */
export const frameworkSheet = (used = []) => {
  const recent = new Set(used.slice(0, 8))
  const order = [...FRAMEWORK.filter((p) => !recent.has(p.text)), ...FRAMEWORK.filter((p) => recent.has(p.text))]
  return order.map((p, i) => `[${i + 1}] ${p.page} (${p.url})${recent.has(p.text) ? ' (used recently: prefer others)' : ''}\n${p.text}`).join('\n\n')
}

/** Records the passages a published piece quoted, newest first. */
export async function markUsed(kv, texts = []) {
  if (!texts.length) return
  const prev = (await kv.get('framework:used', 'json')) || []
  await kv.put('framework:used', JSON.stringify([...texts, ...prev.filter((t) => !texts.includes(t))].slice(0, 20)))
}
