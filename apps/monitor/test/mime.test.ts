import { describe, expect, it } from 'vitest'
import {
  assertHeaderSafe,
  assertMailbox,
  buildMessage,
  CRLF,
  dotStuff,
  encodeHeaderValue,
  formatAddress,
  formatDate,
  mailboxOf,
  mimeBoundary,
  normalizeEol,
  wrapBase64,
} from '../src/core/mime.js'

const message = (over: Partial<Parameters<typeof buildMessage>[0]> = {}) =>
  buildMessage({
    from: 'ClassPik <alerts@classpik.app>',
    to: 'student@example.edu',
    subject: 'MATH 221 B has a seat open',
    text: 'plain',
    html: '<p>rich</p>',
    date: Date.UTC(2026, 6, 28, 22, 4, 11),
    messageId: '<abc@classpik.app>',
    boundary: 'FIXED',
    ...over,
  })

/** Reverses the encoded-word folding so a test can assert on the original text. */
function decodeWords(header: string): string {
  return header
    .split(`${CRLF} `)
    .map((word) => {
      const m = /^=\?UTF-8\?B\?(.*)\?=$/.exec(word)
      return m ? Buffer.from(m[1]!, 'base64').toString('utf8') : word
    })
    .join('')
}

function base64Of(raw: string, part: 'text/plain' | 'text/html'): string {
  const section = raw.split(`Content-Type: ${part}; charset=utf-8`)[1]!
  const body = section.split(`${CRLF}--`)[0]!.split(`${CRLF}${CRLF}`)[1]!
  return Buffer.from(body.split(CRLF).join(''), 'base64').toString('utf8')
}

describe('line endings and dot stuffing', () => {
  it('converts every line ending form to CRLF exactly once', () => {
    expect(normalizeEol('a\nb\r\nc\rd')).toBe('a\r\nb\r\nc\r\nd')
  })

  it('leaves a string that is already CRLF unchanged rather than doubling it', () => {
    expect(normalizeEol('a\r\nb')).toBe('a\r\nb')
  })

  it('doubles a leading dot so the line cannot be read as the end of DATA', () => {
    expect(dotStuff('.')).toBe('..')
    expect(dotStuff('.hidden')).toBe('..hidden')
  })

  it('doubles a dot that starts any interior line, not just the first', () => {
    expect(dotStuff('one\r\n.\r\ntwo')).toBe('one\r\n..\r\ntwo')
    expect(dotStuff('one\r\n.two')).toBe('one\r\n..two')
  })

  it('leaves a dot that is not at the start of a line alone', () => {
    expect(dotStuff('MATH 221. Linear Algebra')).toBe('MATH 221. Linear Algebra')
  })

  it('stuffs an already-doubled dot again, since the receiver strips exactly one', () => {
    expect(dotStuff('..foo')).toBe('...foo')
  })
})

describe('header safety', () => {
  it('rejects a value carrying a newline, because that value would become a header', () => {
    expect(() => assertHeaderSafe('Subject', 'seat open\r\nBcc: attacker@evil.test')).toThrow(
      /line break/
    )
  })

  it('rejects a bare CR as well as a full CRLF', () => {
    expect(() => assertHeaderSafe('Subject', 'seat\ropen')).toThrow(/line break/)
  })

  it('accepts an ordinary course title', () => {
    expect(() => assertHeaderSafe('Subject', 'MATH 221 B has a seat open')).not.toThrow()
  })
})

describe('address validation', () => {
  it('accepts an ordinary campus address', () => {
    expect(() => assertMailbox('student@example.edu')).not.toThrow()
  })

  it('rejects an address with no at sign', () => {
    expect(() => assertMailbox('student.example.edu')).toThrow(/not a usable/)
  })

  it('rejects an address with two at signs', () => {
    expect(() => assertMailbox('a@b@example.edu')).toThrow(/not a usable/)
  })

  it('rejects an empty local part or an empty domain', () => {
    expect(() => assertMailbox('@example.edu')).toThrow(/not a usable/)
    expect(() => assertMailbox('student@')).toThrow(/not a usable/)
  })

  it('rejects a line break, which is the header injection path', () => {
    expect(() => assertMailbox('student@example.edu\r\nBcc: x@y.z')).toThrow(/line break/)
  })

  it('rejects whitespace and angle brackets, which an SMTP path cannot carry', () => {
    expect(() => assertMailbox('a b@example.edu')).toThrow(/cannot carry/)
    expect(() => assertMailbox('<a@example.edu>')).toThrow(/cannot carry/)
  })

  it('rejects a domain with a leading, trailing, or doubled dot', () => {
    expect(() => assertMailbox('a@.example.edu')).toThrow(/unusable domain/)
    expect(() => assertMailbox('a@example.edu.')).toThrow(/unusable domain/)
    expect(() => assertMailbox('a@example..edu')).toThrow(/unusable domain/)
  })

  it('allows a dotless domain so a local relay in development still works', () => {
    expect(() => assertMailbox('alerts@mailpit')).not.toThrow()
  })
})

describe('address formatting', () => {
  it('pulls the bare mailbox out of a display-name form for the SMTP envelope', () => {
    expect(mailboxOf('ClassPik <alerts@classpik.app>')).toBe('alerts@classpik.app')
    expect(mailboxOf('alerts@classpik.app')).toBe('alerts@classpik.app')
  })

  it('quotes a display name containing a comma, which would otherwise read as two addresses', () => {
    expect(formatAddress('Registrar, ClassPik <alerts@classpik.app>')).toBe(
      '"Registrar, ClassPik" <alerts@classpik.app>'
    )
  })

  it('encodes a non-ASCII display name rather than emitting raw bytes in a header', () => {
    const out = formatAddress('Amélie <a@b.test>')
    expect(out).toMatch(/^=\?UTF-8\?B\?.+\?= <a@b\.test>$/)
    expect(decodeWords(out.split(' <')[0]!)).toBe('Amélie')
  })

  it('drops an empty display name to the angle-bracket form', () => {
    expect(formatAddress('  <a@b.test>')).toBe('<a@b.test>')
  })

  it('rejects a display-name form whose address is unusable', () => {
    expect(() => formatAddress('ClassPik <not-an-address>')).toThrow(/not a usable/)
  })
})

describe('RFC 2047 subject encoding', () => {
  it('leaves a printable ASCII subject untouched, since encoding it would only hurt readability', () => {
    expect(encodeHeaderValue('MATH 221 B has a seat open')).toBe('MATH 221 B has a seat open')
  })

  it('encodes a non-ASCII course title so the header stays ASCII', () => {
    const out = encodeHeaderValue('Français 101 A has a seat open')
    expect(out).toContain('=?UTF-8?B?')
    expect(decodeWords(out)).toBe('Français 101 A has a seat open')
  })

  it('keeps every encoded word within the 75 character limit', () => {
    const long = 'Introducción a la Estadística Aplicada para Ciencias Sociales y Económicas'
    for (const word of encodeHeaderValue(long).split(`${CRLF} `)) {
      expect(word.length).toBeLessThanOrEqual(75)
    }
  })

  it('never splits a multi-byte character across two encoded words', () => {
    // Four-byte code points, so a naive byte-count split lands mid-character.
    const emoji = '🎓'.repeat(60)
    const words = encodeHeaderValue(emoji).split(`${CRLF} `)
    expect(words.length).toBeGreaterThan(1)
    for (const word of words) {
      const decoded = Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(word)![1]!, 'base64').toString('utf8')
      expect(decoded).not.toContain('�')
    }
    expect(decodeWords(encodeHeaderValue(emoji))).toBe(emoji)
  })

  it('folds continuation words with CRLF and a space so the header stays a legal one', () => {
    const out = encodeHeaderValue('ñ'.repeat(120))
    expect(out).toContain(`${CRLF} `)
    expect(out.split(CRLF).every((line) => line.length <= 76)).toBe(true)
  })
})

describe('date formatting', () => {
  it('emits the RFC 5322 form with a numeric zone rather than the obsolete GMT', () => {
    expect(formatDate(Date.UTC(2026, 6, 28, 22, 4, 11))).toBe('Tue, 28 Jul 2026 22:04:11 +0000')
  })

  it('pads single digit fields so the header is a fixed shape', () => {
    expect(formatDate(Date.UTC(2026, 0, 5, 3, 7, 9))).toBe('Mon, 05 Jan 2026 03:07:09 +0000')
  })
})

describe('base64 part encoding', () => {
  it('wraps at 76 columns, which keeps every line under the 1000 octet limit', () => {
    const wrapped = wrapBase64('x'.repeat(5_000))
    for (const line of wrapped.split(CRLF)) expect(line.length).toBeLessThanOrEqual(76)
  })

  it('round trips content that no header could carry literally', () => {
    const source = 'Introducción\nline two\n.dot leading line'
    const decoded = Buffer.from(wrapBase64(source).split(CRLF).join(''), 'base64').toString('utf8')
    expect(decoded).toBe('Introducción\r\nline two\r\n.dot leading line')
  })

  it('produces an empty body rather than a stray newline for empty content', () => {
    expect(wrapBase64('')).toBe('')
  })
})

describe('message assembly', () => {
  it('puts text before HTML, since a client renders the last part it understands', () => {
    const raw = message()
    expect(raw.indexOf('text/plain')).toBeLessThan(raw.indexOf('text/html'))
  })

  it('carries the headers a transactional alert needs', () => {
    const raw = message()
    expect(raw).toContain('From: ClassPik <alerts@classpik.app>')
    expect(raw).toContain('To: student@example.edu')
    expect(raw).toContain('Subject: MATH 221 B has a seat open')
    expect(raw).toContain('Date: Tue, 28 Jul 2026 22:04:11 +0000')
    expect(raw).toContain('Message-ID: <abc@classpik.app>')
    expect(raw).toContain('MIME-Version: 1.0')
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="FIXED"')
    // Otherwise a student's vacation responder answers every seat alert.
    expect(raw).toContain('Auto-Submitted: auto-generated')
  })

  it('separates the parts with the boundary and closes it', () => {
    const raw = message()
    expect(raw).toContain(`${CRLF}--FIXED${CRLF}`)
    expect(raw.endsWith(`--FIXED--${CRLF}`)).toBe(true)
  })

  it('uses CRLF everywhere, including inside the body', () => {
    expect(message().split(/\r?\n/).length).toBe(message().split(CRLF).length)
    expect(/[^\r]\n/.test(message())).toBe(false)
  })

  it('carries both alternatives intact', () => {
    const raw = message({ text: 'a seat opened', html: '<p>a seat opened</p>' })
    expect(base64Of(raw, 'text/plain')).toBe('a seat opened')
    expect(base64Of(raw, 'text/html')).toBe('<p>a seat opened</p>')
  })

  it('omits Reply-To entirely when none is configured', () => {
    expect(message()).not.toContain('Reply-To:')
    expect(message({ replyTo: 'help@classpik.app' })).toContain('Reply-To: help@classpik.app')
  })

  it('refuses a subject carrying a line break instead of escaping it', () => {
    expect(() => message({ subject: 'seat open\nBcc: attacker@evil.test' })).toThrow(/line break/)
  })

  it('checks injection before encoding, so a CR cannot hide inside an encoded word', () => {
    // The title is non-ASCII, so it takes the encoding path. A check that ran
    // after encoding would see only base64 and pass.
    expect(() => message({ subject: 'Café\r\nBcc: attacker@evil.test' })).toThrow(/line break/)
  })

  it('emits a random boundary when none is supplied', () => {
    expect(mimeBoundary()).not.toBe(mimeBoundary())
    // Base64 uses no underscore, so the boundary cannot occur inside a part.
    expect(mimeBoundary()).toMatch(/^=_cp_[0-9a-f]{24}$/)
  })
})
