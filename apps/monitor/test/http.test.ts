import { describe, expect, it, vi } from 'vitest'
import { PoliteClient } from '../src/adapters/http.js'

/**
 * These tests exist because the realistic way this service dies is not a crash.
 * It is a registrar quietly blocking our IP, after which every user at that
 * school silently stops getting alerts. The rate limiting is the product.
 */

function stub(responses: Array<() => Response | Promise<Response>>) {
  let i = 0
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url))
    const next = responses[Math.min(i, responses.length - 1)]!
    i++
    return next()
  }) as unknown as typeof fetch
  return { fetchImpl, calls, get count() { return i } }
}

const ok = () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })

describe('PoliteClient', () => {
  it('sends an identifying User-Agent so an admin can find us', async () => {
    let ua: string | null = null
    const fetchImpl = (async (_url: string | URL, init: RequestInit = {}) => {
      ua = new Headers(init.headers).get('user-agent')
      return ok()
    }) as unknown as typeof fetch

    await new PoliteClient({ fetchImpl, minRequestGapMs: 0 }).request('https://x.test/')
    expect(ua).toContain('ClassPikMonitor')
    expect(ua).toContain('github.com')
  })

  it('enforces a minimum gap between requests to one host', async () => {
    const slept: number[] = []
    const s = stub([ok])
    const client = new PoliteClient({
      fetchImpl: s.fetchImpl,
      minRequestGapMs: 500,
      sleep: async (ms) => { slept.push(ms) },
      now: (() => { let t = 0; return () => (t += 100) })(),
    })
    await client.request('https://x.test/a')
    await client.request('https://x.test/b')
    expect(slept.some((ms) => ms > 0)).toBe(true)
  })

  it('retries a 500 and succeeds', async () => {
    const s = stub([
      () => new Response('boom', { status: 500 }),
      () => new Response('boom', { status: 500 }),
      ok,
    ])
    const client = new PoliteClient({ fetchImpl: s.fetchImpl, minRequestGapMs: 0, sleep: async () => {} })
    const res = await client.request('https://x.test/')
    expect(res.status).toBe(200)
    expect(s.count).toBe(3)
  })

  it('retries a 429', async () => {
    const s = stub([() => new Response('slow down', { status: 429 }), ok])
    const client = new PoliteClient({ fetchImpl: s.fetchImpl, minRequestGapMs: 0, sleep: async () => {} })
    await client.request('https://x.test/')
    expect(s.count).toBe(2)
  })

  it('honours a numeric Retry-After header', async () => {
    const slept: number[] = []
    const s = stub([
      () => new Response('wait', { status: 429, headers: { 'retry-after': '7' } }),
      ok,
    ])
    const client = new PoliteClient({
      fetchImpl: s.fetchImpl, minRequestGapMs: 0, sleep: async (ms) => { slept.push(ms) },
    })
    await client.request('https://x.test/')
    expect(slept).toContain(7000)
  })

  it('caps a hostile Retry-After at one minute', async () => {
    const slept: number[] = []
    const s = stub([
      () => new Response('wait', { status: 429, headers: { 'retry-after': '86400' } }),
      ok,
    ])
    const client = new PoliteClient({
      fetchImpl: s.fetchImpl, minRequestGapMs: 0, sleep: async (ms) => { slept.push(ms) },
    })
    await client.request('https://x.test/')
    expect(Math.max(...slept)).toBeLessThanOrEqual(60_000)
  })

  it('gives up after maxRetries and reports the attempt count', async () => {
    const s = stub([() => new Response('boom', { status: 503 })])
    const client = new PoliteClient({
      fetchImpl: s.fetchImpl, minRequestGapMs: 0, maxRetries: 2, sleep: async () => {},
    })
    await expect(client.request('https://x.test/')).rejects.toThrow(/503 after 3 attempts/)
    expect(s.count).toBe(3)
  })

  it('does NOT retry a 404, because asking again will not help', async () => {
    const s = stub([() => new Response('nope', { status: 404 })])
    const client = new PoliteClient({ fetchImpl: s.fetchImpl, minRequestGapMs: 0, sleep: async () => {} })
    await expect(client.request('https://x.test/')).rejects.toMatchObject({ transient: false })
    expect(s.count).toBe(1)
  })

  it('retries a network-level failure', async () => {
    let n = 0
    const fetchImpl = (async () => {
      if (n++ < 1) throw new Error('ECONNRESET')
      return ok()
    }) as unknown as typeof fetch
    const client = new PoliteClient({ fetchImpl, minRequestGapMs: 0, sleep: async () => {} })
    expect((await client.request('https://x.test/')).status).toBe(200)
  })

  it('applies jitter so parallel workers do not resynchronise', async () => {
    const delays = new Set<number>()
    for (const r of [0.01, 0.3, 0.7, 0.99]) {
      const s = stub([() => new Response('x', { status: 500 }), ok])
      const client = new PoliteClient({
        fetchImpl: s.fetchImpl, minRequestGapMs: 0, random: () => r,
        sleep: async (ms) => { delays.add(ms) },
      })
      await client.request('https://x.test/')
    }
    expect(delays.size).toBeGreaterThan(1)
  })

  it('never exceeds maxConcurrent in flight against one host', async () => {
    let inFlight = 0
    let peak = 0
    const fetchImpl = (async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return ok()
    }) as unknown as typeof fetch

    const client = new PoliteClient({ fetchImpl, maxConcurrent: 2, minRequestGapMs: 0 })
    await Promise.all(Array.from({ length: 8 }, (_, i) => client.request(`https://x.test/${i}`)))
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('tracks concurrency per host rather than globally', async () => {
    const perHost = new Map<string, number>()
    const peak = new Map<string, number>()
    const fetchImpl = (async (url: string | URL) => {
      const h = new URL(String(url)).host
      const n = (perHost.get(h) ?? 0) + 1
      perHost.set(h, n)
      peak.set(h, Math.max(peak.get(h) ?? 0, n))
      await new Promise((r) => setTimeout(r, 5))
      perHost.set(h, n - 1)
      return ok()
    }) as unknown as typeof fetch

    const client = new PoliteClient({ fetchImpl, maxConcurrent: 1, minRequestGapMs: 0 })
    await Promise.all([
      client.request('https://a.test/1'),
      client.request('https://a.test/2'),
      client.request('https://b.test/1'),
    ])
    expect(peak.get('a.test')).toBe(1)
    expect(peak.get('b.test')).toBe(1)
  })

  it('releases its concurrency slot even when a request throws', async () => {
    let n = 0
    const fetchImpl = (async () => {
      if (n++ === 0) throw new Error('fail')
      return ok()
    }) as unknown as typeof fetch
    const client = new PoliteClient({ fetchImpl, maxConcurrent: 1, minRequestGapMs: 0, sleep: async () => {} })
    // If the slot leaked, this second call would hang forever.
    await client.request('https://x.test/')
    await expect(client.request('https://x.test/')).resolves.toBeDefined()
  })

  it('parses JSON and reports the body when it is not JSON', async () => {
    const s = stub([() => new Response('{"a":1}', { status: 200 })])
    const client = new PoliteClient({ fetchImpl: s.fetchImpl, minRequestGapMs: 0 })
    expect(await client.json('https://x.test/')).toEqual({ a: 1 })

    const html = stub([() => new Response('<html><body>Login required</body></html>', { status: 200 })])
    const c2 = new PoliteClient({ fetchImpl: html.fetchImpl, minRequestGapMs: 0 })
    await expect(c2.json('https://x.test/')).rejects.toThrow(/Login required/)
  })

  it('gives up rather than spend more than its total budget on one request', async () => {
    // Retries multiplied out to over four minutes for a single call: three
    // retries at a 20s timeout, each honouring a 60s Retry-After. The poller's
    // lease was written against a much smaller number than that, so the window
    // where two workers fetched the same subject opened exactly when a
    // registrar was rate limiting us.
    let t = 0
    const s = stub([() => new Response('wait', { status: 429, headers: { 'retry-after': '60' } })])
    const client = new PoliteClient({
      fetchImpl: s.fetchImpl,
      minRequestGapMs: 0,
      maxRetries: 100,
      maxTotalMs: 90_000,
      // The clock moves with the sleep, which is what a real wait does.
      sleep: async (ms) => { t += ms },
      now: () => t,
    })

    await expect(client.request('https://x.test/')).rejects.toThrow(/429 after 2 attempts/)
    // maxRetries alone would have allowed a hundred.
    expect(s.count).toBe(2)
    expect(t).toBeLessThanOrEqual(90_000)
  })

  it('leaves a request that fits inside the budget alone', async () => {
    let t = 0
    const s = stub([
      () => new Response('wait', { status: 429, headers: { 'retry-after': '5' } }),
      ok,
    ])
    const client = new PoliteClient({
      fetchImpl: s.fetchImpl,
      minRequestGapMs: 0,
      maxTotalMs: 90_000,
      sleep: async (ms) => { t += ms },
      now: () => t,
    })
    expect((await client.request('https://x.test/')).status).toBe(200)
  })

  it('aborts a request that exceeds the timeout', async () => {
    const fetchImpl = (async (_u: string | URL, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch

    const client = new PoliteClient({
      fetchImpl, minRequestGapMs: 0, timeoutMs: 10, maxRetries: 0, sleep: async () => {},
    })
    await expect(client.request('https://x.test/')).rejects.toThrow()
  }, 5000)
})
