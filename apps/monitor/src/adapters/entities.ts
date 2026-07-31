/**
 * HTML entity decoding for text that arrives from a student system.
 *
 * Both Banner and PeopleSoft escape free text on the way out, even in their
 * JSON endpoints, because the same strings are rendered into their own pages.
 * Georgia Tech's subject list is the plain example: it sends
 * `Chemical &amp; Biomolecular Engr`, and without this a student searching for
 * "Chemical & Biomolecular" matches nothing and the UI shows the raw entity.
 *
 * Two decisions worth stating:
 *
 *  - This decodes in a single pass rather than a chain of replaces. Chained
 *    replaces decode their own output, so `&amp;lt;` (a literal "&lt;" the
 *    registrar meant to display) would come out as `<`. One pass cannot.
 *  - Only the entities a course catalog actually uses are named. Anything
 *    unrecognised is left exactly as it came in, on the grounds that showing
 *    `&foo;` is a smaller lie than guessing at it or dropping it.
 *
 * This is decoding for display, not sanitisation. Nothing here makes a string
 * safe to interpolate into HTML, and nothing in this codebase does that: the
 * web app renders these as React text nodes.
 */

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // Registrars use these for padding and for course titles typed in Word.
  // They are folded to their plain equivalents so that a title trims cleanly
  // and so search does not depend on which dash the registrar happened to use.
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: '...',
  deg: '°',
}

/** A code point, or null if it is not one we are willing to emit. */
function fromCodePoint(cp: number): string | null {
  if (!Number.isInteger(cp) || cp < 1 || cp > 0x10ffff) return null
  // Lone surrogates would produce an unpaired half and corrupt the string.
  if (cp >= 0xd800 && cp <= 0xdfff) return null
  return String.fromCodePoint(cp)
}

const ENTITY = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g

/**
 * Decode HTML entities in a string from a student system.
 *
 * Call this *after* stripping tags, never before: decoding first would turn a
 * literal `&lt;b&gt;` into markup that the tag stripper then eats.
 */
export function decodeEntities(input: string): string {
  // The overwhelmingly common case is a string with no entity in it at all.
  if (!input.includes('&')) return input

  return input.replace(ENTITY, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const digits = hex ? body.slice(2) : body.slice(1)
      const cp = Number.parseInt(digits, hex ? 16 : 10)
      return fromCodePoint(cp) ?? whole
    }
    // Named entities are case sensitive in HTML, so `&AMP;` is not `&amp;`.
    return NAMED[body] ?? whole
  })
}

/** Coerce an unknown SIS field to decoded, trimmed display text. */
export function text(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return ''
  return decodeEntities(v).trim()
}
