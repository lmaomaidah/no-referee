import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { verifyEvent } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools/pure'

type Filter = { kinds?: number[], authors?: string[], '#g'?: string[], '#r'?: string[], since?: number, limit?: number }
export type Fault = (event: Event) => 'pass' | 'drop' | { delayMs: number }

const LISTS = ['kinds', 'authors', '#g', '#r'] as const
const validFilter = (f: Filter) => typeof f === 'object' && f !== null
  && LISTS.every(k => f[k] === undefined || Array.isArray(f[k]))

const hasTag = (e: Event, name: string, values?: string[]) =>
  !values || e.tags.some(t => t[0] === name && values.includes(t[1]))

const matches = (f: Filter, e: Event) =>
  (!f.kinds || f.kinds.includes(e.kind))
  && (!f.authors || f.authors.includes(e.pubkey))
  && hasTag(e, 'g', f['#g']) && hasTag(e, 'r', f['#r'])
  && (f.since === undefined || e.created_at >= f.since)

/**
 * `fault` sees each validly signed EVENT. The sender gets OK true whatever it answers, so a
 * dropping or delaying relay cannot be told from an honest one. Varying delayMs reorders.
 */
export async function startRelay({ port, fault }: { port: number, fault?: Fault }) {
  // ponytail: unbounded in-memory store, fine for one game; cap it if a relay ever outlives a demo.
  const store = new Map<string, Event>()
  const subs = new Map<WebSocket, Map<string, Filter[]>>()
  const wss = new WebSocketServer({ port, host: '127.0.0.1' })
  await new Promise((ok, no) => { wss.once('listening', ok); wss.once('error', no) })

  const send = (ws: WebSocket, ...msg: unknown[]) => ws.send(JSON.stringify(msg))

  function publish(e: Event) {
    if (store.has(e.id)) return // players rebroadcast everything they see
    store.set(e.id, e)
    for (const [ws, mine] of subs) {
      for (const [id, filters] of mine) if (filters.some(f => matches(f, e))) send(ws, 'EVENT', id, e)
    }
  }

  function onEvent(ws: WebSocket, e: Event) {
    if (!verifyEvent(e)) return send(ws, 'OK', e.id, false, 'invalid: bad signature')
    const verdict = fault?.(e) ?? 'pass'
    send(ws, 'OK', e.id, true, '')
    if (verdict === 'pass') publish(e)
    else if (verdict !== 'drop') setTimeout(publish, verdict.delayMs, e).unref()
  }

  function onReq(ws: WebSocket, id: string, filters: Filter[]) {
    if (typeof id !== 'string' || !filters.length || !filters.every(validFilter)) throw new Error('bad REQ')
    subs.get(ws)!.set(id, filters)
    const newest = [...store.values()].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
    const found = new Set<Event>()
    for (const f of filters) {
      for (const e of newest.filter(e => matches(f, e)).slice(0, f.limit)) found.add(e)
    }
    for (const e of found) send(ws, 'EVENT', id, e)
    send(ws, 'EOSE', id)
  }

  wss.on('connection', ws => {
    subs.set(ws, new Map())
    ws.on('close', () => subs.delete(ws))
    ws.on('error', () => ws.terminate()) // bad frames land here; unhandled it would crash the process
    ws.on('message', data => {
      try {
        const [type, ...rest] = JSON.parse(data.toString())
        if (type === 'EVENT') onEvent(ws, rest[0])
        else if (type === 'REQ') onReq(ws, rest[0], rest.slice(1))
        else if (type === 'CLOSE') subs.get(ws)!.delete(rest[0])
        else throw new Error('unknown message')
      } catch {
        send(ws, 'NOTICE', 'invalid: message ignored')
      }
    })
  })

  return {
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    close: () => new Promise<void>((ok, no) => {
      for (const ws of wss.clients) ws.terminate()
      wss.close(err => (err ? no(err) : ok()))
    }),
  }
}
