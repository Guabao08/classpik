/**
 * Academic level, as the registrar spells it.
 *
 * Pure and IO-free, for the same reason `diff.ts` is: this decides what a
 * student is shown, so it has to be checkable on its own.
 *
 * One rule shapes the whole file. We do not know the level codes and we never
 * will. Banner installs answer UG and GR, and also LW, MD, PH and things nobody
 * outside that campus has seen. PeopleSoft calls the same idea Academic Career
 * and answers UGRD, GRAD, LAW, MEDS. Some spell out "Undergraduate". Folding
 * that into an enum of two options would drop every level we had not thought
 * of, and the student who loses their entire catalog is the law or medical one.
 * So the registrar's own code is what we store and what we display, and
 * normalisation exists only so that two of them can be compared.
 */

/**
 * Longest code we will keep. Registrar codes are two to six characters, and a
 * spelled-out description is still comfortably inside this. Anything longer is
 * a paragraph or a mistake, and either way it is not a level.
 */
export const MAX_LEVEL_LENGTH = 40

/**
 * How many levels one account may hold. A senior in a graduate seminar needs
 * two; a genuinely unusual case needs three. Eight is well past any of them and
 * exists so a caller cannot make one account's search predicate unbounded.
 */
export const MAX_LEVELS = 8

/**
 * The comparable form of a level code. Case and spacing only: UGRD and ugrd are
 * the same level, "UGRD" and "GRAD" are not, and this function is deliberately
 * incapable of deciding that "Undergraduate" and "UG" are. Guessing at that
 * would quietly merge two levels a registrar keeps apart, which is worse than
 * showing a student a second checkbox.
 */
export function normalizeLevel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase()
}

/**
 * Reads a list of level codes off untrusted input, keeping each one exactly as
 * it was written and rejecting what cannot be stored.
 *
 * Duplicates are dropped by normalised form rather than by raw string, so a
 * client that sends both "ugrd" and "UGRD" has ticked one box, not two. The
 * first spelling wins, because that is the one the caller saw.
 *
 * Throws rather than silently discarding, since a level the account thinks it
 * selected but that we dropped is a search that quietly hides classes.
 */
export function parseLevels(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new Error('levels must be a list of level codes, for example ["UGRD","GRAD"]')
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of input) {
    if (typeof value !== 'string') throw new Error('every level must be a string')
    const code = value.trim().replace(/\s+/g, ' ')
    if (code === '') continue
    if (code.length > MAX_LEVEL_LENGTH) {
      throw new Error(`level codes are at most ${MAX_LEVEL_LENGTH} characters`)
    }
    const norm = normalizeLevel(code)
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(code)
  }
  if (out.length > MAX_LEVELS) throw new Error(`at most ${MAX_LEVELS} levels can be selected`)
  return out
}
