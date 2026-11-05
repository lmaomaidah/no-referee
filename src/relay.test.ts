import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools/pure'
import { startRelay } from './relay.ts'

const sk = generateSecretKey()
const sk2 = generateSecretKey()
// The JSON round trip drops the symbol finalizeEvent adds, so events compare equal to what the wire returns.
const ev = (kind: number, g: string, r: string, created_at = 100, key = sk): Event =>
  JSON.parse(JSON.stringify(finalizeEvent({ kind, created_at, tags: [['g', g], ['r', r]], content: 'x' }, key)))

// Test client: next() resolves with the next message, or null after `ms` of silence.
async function connect(url: string) {
  const ws = new WebSocket(url)
  const inbox: any[][] = []
  let wake = () => {}
  ws.onmessage = m => { inbox.push(JSON.parse(m.data as string)); wake() }
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })
  const next = async (ms = 500): Promise<any[] | null> => {
    if (!inbox.length) {
      await new Promise<void>(ok => { const t = setTimeout(ok, ms); wake = () => { clearTimeout(t); ok() } })
    }
    return inbox.shift() ?? null
  }
  const send = (...msg: unknown[]) => ws.send(JSON.stringify(msg))
  const publish = async (e: Event) => { send('EVENT', e); return next() }
  // Runs a REQ and returns the stored events delivered before EOSE.
  let n = 0
  const query = async (filter: object) => {
    const id = `q${n++}`
    send('REQ', id, filter)
    const out: Event[] = []
    for (;;) {
      const m = await next()
      assert.ok(m, 'no EOSE')
      assert.equal(m[1], id)
      if (m[0] === 'EOSE') { send('CLOSE', id); return out }
      out.push(m[2])
    }
  }
  return { ws, next, send, publish, query }
}

test('stores, replies OK, fans out live and replays to later subscribers', async t => {
  const relay = await startRelay({ port: 0 })
  t.after(() => relay.close())
  const a = await connect(relay.url), b = await connect(relay.url)
  a.send('REQ', 's', { kinds: [7301] })
  assert.deepEqual(await a.next(), ['EOSE', 's'])

  const e = ev(7301, 'g1', '0')
  assert.deepEqual(await b.publish(e), ['OK', e.id, true, ''])
  assert.deepEqual(await a.next(), ['EVENT', 's', e])
  assert.deepEqual(await b.query({ kinds: [7301] }), [e])
})

test('a duplicate is accepted but not stored or fanned out twice', async t => {
  const relay = await startRelay({ port: 0 })
  t.after(() => relay.close())
  const a = await connect(relay.url), b = await connect(relay.url)
  a.send('REQ', 's', {})
  await a.next()
  const e = ev(7301, 'g1', '0')
  await b.publish(e)
  assert.equal((await b.publish(e))?.[2], true)
  assert.deepEqual(await a.next(), ['EVENT', 's', e])
  assert.equal(await a.next(100), null)
  assert.equal((await b.query({})).length, 1)
})

test('rejects a bad signature and a changed payload', async t => {
  const relay = await startRelay({ port: 0 })
  t.after(() => relay.close())
  const a = await connect(relay.url), b = await connect(relay.url)
  b.send('REQ', 's', {})
  await b.next()
  const e = ev(7301, 'g1', '0')
  const flipped = e.sig[0] === '0' ? '1' : '0'
  for (const bad of [{ ...e, sig: flipped + e.sig.slice(1) }, { ...e, content: 'y' }]) {
    const reply = await a.publish(bad)
    assert.deepEqual(reply?.slice(0, 3), ['OK', e.id, false])
  }
  assert.deepEqual(await a.query({}), [])
  assert.equal(await b.next(100), null)
})

test('filters: kinds, authors, #g, #r, since, limit, several filters, CLOSE', async t => {
  const relay = await startRelay({ port: 0 })
  t.after(() => relay.close())
  const a = await connect(relay.url)
  const e1 = ev(7301, 'g1', '1', 100), e2 = ev(7302, 'g1', '2', 200), e3 = ev(7301, 'g2', '1', 300, sk2)
  for (const e of [e1, e2, e3]) await a.publish(e)
  const ids = async (f: object) => (await a.query(f)).map(e => e.id).sort()
  const want = (...es: Event[]) => es.map(e => e.id).sort()

  assert.deepEqual(await ids({ '#g': ['g1'] }), want(e1, e2))
  assert.deepEqual(await ids({ '#g': ['g2'] }), want(e3))
  assert.deepEqual(await ids({ '#g': ['nope'] }), [])
  assert.deepEqual(await ids({ '#r': ['1'] }), want(e1, e3))
  assert.deepEqual(await ids({ '#g': ['g1'], '#r': ['1'] }), want(e1))
  assert.deepEqual(await ids({ kinds: [7302] }), want(e2))
  assert.deepEqual(await ids({ authors: [e3.pubkey] }), want(e3))
  assert.deepEqual(await ids({ since: 200 }), want(e2, e3))
  assert.deepEqual(await a.query({ limit: 2 }), [e3, e2]) // newest first

  a.send('REQ', 'two', { kinds: [7301] }, { '#g': ['g1'] }) // OR, each event once
  const seen = []
  for (let m = await a.next(); m?.[0] === 'EVENT'; m = await a.next()) seen.push(m[2].id)
  assert.deepEqual(seen.sort(), want(e1, e2, e3))
  a.send('CLOSE', 'two')

  // live delivery obeys the filter, and CLOSE stops it
  const b = await connect(relay.url)
  b.send('REQ', 'live', { '#g': ['g9'] })
  await b.next()
  await a.publish(ev(7301, 'g8', '0'))
  assert.equal(await b.next(100), null)
  const e4 = ev(7301, 'g9', '0')
  await a.publish(e4)
  assert.deepEqual(await b.next(), ['EVENT', 'live', e4])
  b.send('CLOSE', 'live')
  await b.query({ limit: 0 }) // messages are handled in order, so CLOSE is done
  await a.publish(ev(7301, 'g9', '1'))
  assert.equal(await b.next(100), null)
})

test('fault drop: sender sees OK, nobody gets the event', async t => {
  const relay = await startRelay({ port: 0, fault: e => (e.kind === 7302 ? 'drop' : 'pass') })
  t.after(() => relay.close())
  const a = await connect(relay.url), b = await connect(relay.url)
  b.send('REQ', 's', {})
  await b.next()
  const dropped = ev(7302, 'g1', '0'), kept = ev(7301, 'g1', '0')
  assert.equal((await a.publish(dropped))?.[2], true)
  assert.equal((await a.publish(kept))?.[2], true)
  assert.deepEqual(await b.next(), ['EVENT', 's', kept])
  assert.equal(await b.next(100), null)
  assert.deepEqual(await a.query({}), [kept])
})

test('fault delay: held back, then stored and delivered, so events can be reordered', async t => {
  const relay = await startRelay({ port: 0, fault: e => (e.kind === 7302 ? { delayMs: 150 } : 'pass') })
  t.after(() => relay.close())
  const a = await connect(relay.url), b = await connect(relay.url)
  b.send('REQ', 's', {})
  await b.next()
  const late = ev(7302, 'g1', '0'), early = ev(7301, 'g1', '0')
  await a.publish(late)
  assert.deepEqual(await a.query({}), [])
  await a.publish(early)
  assert.deepEqual(await b.next(), ['EVENT', 's', early])
  assert.deepEqual(await b.next(), ['EVENT', 's', late])
  assert.equal((await a.query({})).length, 2)
})

test('fault never sees a forged event', async t => {
  const seen: string[] = []
  const relay = await startRelay({ port: 0, fault: e => { seen.push(e.id); return 'pass' } })
  t.after(() => relay.close())
  const a = await connect(relay.url)
  await a.publish({ ...ev(7301, 'g1', '0'), content: 'y' })
  assert.deepEqual(seen, [])
})

test('survives garbage from a client and keeps serving everyone', async t => {
  const relay = await startRelay({ port: 0 })
  t.after(() => relay.close())
  const a = await connect(relay.url), b = await connect(relay.url)
  const junk = [
    'not json', '', '{}', '[]', 'null', '42', '["NOPE"]', '["EVENT"]', '["EVENT",null]', '["EVENT",{}]', '["EVENT",7]',
    '["REQ"]', '["REQ",1,{}]', '["REQ","x",null]', '["REQ","x",{"kinds":"7301"}]', '["REQ","x",{"#g":5}]', '["CLOSE"]',
  ]
  for (const j of junk) a.ws.send(j)
  a.ws.send(new Uint8Array([0, 255, 1, 2]))

  b.send('REQ', 's', {})
  await b.next()
  const e = ev(7301, 'g1', '0')
  assert.equal((await b.publish(e))?.[2], true)
  assert.deepEqual(await b.next(), ['EVENT', 's', e])

  // No rejected filter may sit in the subscription list and reach fan-out.
  for (let m = await a.next(100); m; m = await a.next(100)) assert.ok(['NOTICE', 'OK'].includes(m[0]), String(m))
  assert.deepEqual(await a.query({ kinds: [7301] }), [e])
})

test('close() ends connections and frees the port', async () => {
  const relay = await startRelay({ port: 0 })
  const a = await connect(relay.url)
  const closed = new Promise(ok => { a.ws.onclose = ok })
  await relay.close()
  await closed
  const again = await startRelay({ port: Number(new URL(relay.url).port) })
  await again.close()
})
