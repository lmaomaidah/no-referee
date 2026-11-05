import { getPublicKey } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools/pure'
import { commitment, makeChain, randomNonce, randomScalar, seedForRound, split } from './crypto.ts'
import { buildCommit, buildRecover, buildReveal, buildSetup, decryptShare, gameId, parse } from './protocol.ts'
import type { Config, Move, Parsed, Setup } from './protocol.ts'
import { stateHash } from './game.ts'
import { replay } from './verify.ts'
import type { Result } from './verify.ts'
import type { Strategy } from './bots.ts'

export type PlayerOptions = {
  config: Config, sk: Uint8Array, relays: string[], strategy: Strategy,
  timeoutMs: number,   // local patience before voting someone absent; never part of the rules
  settleMs: number,    // wait after a round resolves so late copies arrive
}

/**
 * One tribute. Each tick replays everything seen so far and acts on what the replay is
 * waiting for, so live play cannot drift from the verifier's rules.
 */
export function runPlayer(o: PlayerOptions): Promise<{ result: Result, events: Event[] }> {
  const { config, sk, strategy } = o
  const me = getPublicKey(sk), id = gameId(config), R = config.rounds
  const s0 = randomScalar(), chain = makeChain(s0, R)
  const seen = new Map<string, Parsed>()
  const sockets = o.relays.map(url => new WebSocket(url))
  const mine = new Map<number, { move: Move, nonce: string, revealed: boolean }>()
  const voted = new Set<string>()
  let silent = false, deciding = false, setupSent = false
  let waitKey = '', waitSince = Date.now(), settledRound = -1, settleUntil = 0

  const send = (ws: WebSocket, msg: unknown[]) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)) }
  const publish = (e: Event) => { take(e); sockets.forEach(ws => send(ws, ['EVENT', e])) }

  /** Stores a valid event and rebroadcasts it, so a relay that dropped it still gets a copy. */
  function take(raw: unknown) {
    // Before parse: signature checks are the slow part, and every relay sends a copy.
    if (seen.has((raw as Event)?.id)) return
    const p = parse(raw, config)
    if (!p) return
    seen.set(p.event.id, p)
    if (!silent) sockets.forEach(ws => send(ws, ['EVENT', p.event]))
  }

  function vote(round: number, target: string) {
    const key = `${round}:${target}`
    const setup = [...seen.values()].find(e => e.type === 'setup' && e.pubkey === target) as Setup
    const share = target !== me && !voted.has(key) && decryptShare(setup, sk, config)
    if (!share) return
    voted.add(key)
    publish(buildRecover(config, sk, round, target, share))
  }

  async function act(result: Result) {
    const p = result.pending!, r = p.round
    if (!setupSent) {
      setupSent = true
      return publish(buildSetup(config, sk, chain.at(-1)!, split(s0, config.roster.length, config.k)))
    }
    if (p.noSetup.length) return

    if (r !== settledRound) { settledRound = r; settleUntil = Date.now() + o.settleMs }
    if (Date.now() < settleUntil) return

    if (p.alive.includes(me) && !mine.has(r) && !deciding) {
      deciding = true
      const move = p.state === null ? { a: 'hide' as const } : await strategy(p.state, me)
      deciding = false
      if (move === null) { silent = true; return }
      const nonce = randomNonce()
      mine.set(r, { move, nonce, revealed: false })
      const state = p.state === null ? id : stateHash(p.state)
      return publish(buildCommit(config, sk, r, commitment(id, r, me, move, nonce), state))
    }

    const plan = mine.get(r)
    if (plan && !plan.revealed && !p.noCommit.length) {
      plan.revealed = true
      return publish(buildReveal(config, sk, r, plan.move, plan.nonce, seedForRound(chain, r)))
    }

    const blocking = p.noCommit.length ? p.noCommit : p.noSeed
    const key = `${r}|${blocking}`
    if (key !== waitKey) { waitKey = key; waitSince = Date.now() }
    if (Date.now() - waitSince >= o.timeoutMs) blocking.forEach(t => vote(r, t))
  }

  return new Promise((resolve, reject) => {
    let open = 0, busy = false
    for (const ws of sockets) {
      ws.onmessage = m => { const [t, , e] = JSON.parse(String(m.data)); if (t === 'EVENT') take(e) }
      ws.onerror = () => reject(new Error('relay connection failed'))
      ws.onopen = () => { send(ws, ['REQ', 'game', { '#g': [id] }]); open++ }
    }
    const timer = setInterval(async () => {
      if (busy || open < sockets.length) return
      busy = true
      try {
        const result = replay([...seen.values()], config)
        if (result.status === 'finished') {
          clearInterval(timer)
          sockets.forEach(ws => ws.close())
          return resolve({ result, events: [...seen.values()].map(p => p.event) })
        }
        if (!silent) await act(result)
      } catch (err) {
        clearInterval(timer)
        reject(err)
      } finally {
        busy = false
      }
    }, 5)
  })
}
