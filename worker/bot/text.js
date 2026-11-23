// Post text for Bluesky: a post is at most 300 graphemes and 3,000 bytes (the app.bsky.feed.post lexicon), and a
// link is clickable only with a facet giving its UTF-8 byte range.
const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const enc = new TextEncoder()

export const MAX_GRAPHEMES = 300
export const MAX_BYTES = 3000
export const graphemes = (s) => [...seg.segment(String(s))].length
export const bytes = (s) => enc.encode(String(s)).length
export const fits = (s) => graphemes(s) <= MAX_GRAPHEMES && bytes(s) <= MAX_BYTES

/** Link facets for each URL that appears in the text. */
export function linkFacets(text, urls = []) {
  const facets = []
  for (const uri of urls) {
    const i = text.indexOf(uri)
    if (i < 0) continue
    const byteStart = bytes(text.slice(0, i))
    facets.push({ index: { byteStart, byteEnd: byteStart + bytes(uri) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri }] })
  }
  return facets
}

/** Every http(s) URL in a text, without trailing punctuation. */
export const urlsIn = (text) => [...String(text).matchAll(/https?:\/\/[^\s<>"]+/g)].map((m) => m[0].replace(/[.,;:!?)]+$/, ''))
