import { describe, expect, it } from 'vitest'
import { decodeEntities, text } from '../src/adapters/entities.js'

describe('decodeEntities', () => {
  it('decodes the entity Georgia Tech actually sends', () => {
    // Observed live on 2026-07-31 in Banner's get_subject response.
    expect(decodeEntities('Chemical &amp; Biomolecular Engr')).toBe(
      'Chemical & Biomolecular Engr'
    )
    expect(decodeEntities('Computational Mod, Sim, &amp; Data')).toBe(
      'Computational Mod, Sim, & Data'
    )
  })

  it('does not decode its own output', () => {
    // The bug a chain of .replace() calls would have: `&amp;lt;` is a registrar
    // trying to display the text "&lt;", not markup.
    expect(decodeEntities('&amp;lt;')).toBe('&lt;')
    expect(decodeEntities('&amp;amp;')).toBe('&amp;')
  })

  it('handles the rest of the basic set', () => {
    expect(decodeEntities('a &lt;b&gt; c')).toBe('a <b> c')
    expect(decodeEntities('&quot;Special&quot; Topics')).toBe('"Special" Topics')
    expect(decodeEntities('Diff&apos;l Equations')).toBe("Diff'l Equations")
  })

  it('decodes numeric references in both bases', () => {
    expect(decodeEntities('Diff&#39;l Eq')).toBe("Diff'l Eq")
    expect(decodeEntities('&#38;')).toBe('&')
    expect(decodeEntities('&#x26;')).toBe('&')
    expect(decodeEntities('&#X26;')).toBe('&')
  })

  it('folds padding and typography to plain equivalents', () => {
    // nbsp folds to a real space so that .trim() can reach it.
    expect(decodeEntities('CS 1301&nbsp;').trim()).toBe('CS 1301')
    expect(decodeEntities('Intro&ndash;Advanced')).toBe('Intro-Advanced')
    expect(decodeEntities('&ldquo;Topics&rdquo;')).toBe('"Topics"')
  })

  it('leaves anything it does not recognise exactly as it came in', () => {
    // Showing &foo; is a smaller lie than guessing at it or dropping it.
    expect(decodeEntities('Smith &foo; Jones')).toBe('Smith &foo; Jones')
    expect(decodeEntities('R&D')).toBe('R&D')
    expect(decodeEntities('a & b')).toBe('a & b')
    // Named entities are case sensitive in HTML.
    expect(decodeEntities('&AMP;')).toBe('&AMP;')
  })

  it('refuses code points that would corrupt the string', () => {
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;') // lone surrogate
    expect(decodeEntities('&#x110000;')).toBe('&#x110000;') // past the last plane
    expect(decodeEntities('&#0;')).toBe('&#0;')
  })

  it('is a pass-through when there is nothing to do', () => {
    expect(decodeEntities('')).toBe('')
    expect(decodeEntities('Computer Science')).toBe('Computer Science')
  })
})

describe('text', () => {
  it('decodes and trims in one step', () => {
    expect(text('  Chemical &amp; Biomolecular Engr ')).toBe('Chemical & Biomolecular Engr')
  })

  it('treats a missing field as empty rather than "undefined"', () => {
    expect(text(undefined)).toBe('')
    expect(text(null)).toBe('')
    expect(text({})).toBe('')
    expect(text(Number.NaN)).toBe('')
  })

  it('keeps a numeric field', () => {
    expect(text(3)).toBe('3')
  })
})
