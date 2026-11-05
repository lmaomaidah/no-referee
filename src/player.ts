import { getPublicKey } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools/pure'
import { commitment, makeChain, randomNonce, randomScalar, seedForRound, split } from './crypto.ts'
import { buildChat, buildCommit, buildRecover, buildReveal, buildSetup, decryptShare, gameId, parse, readChat } from './protocol.ts'
import type { Config, Move, Parsed, Setup } from './protocol.ts'
import { stateHash } from './game.ts'
import { replay } from './verify.ts'
import type { Result } from './verify.ts'
import type { Strategy, Talk } from './bots.ts'

/** Red team: this player cheats in one round. Honest players never set it. */
export type Attack = { kind: 'equivocate' | 'change-move' | 'illegal' | 'lie-state' | 'withhold' | 'forge', round: number }

export type Heard = { round: number, from: string, to: string, text: string }

export type PlayerOptions = {
  config: Config, sk: Uint8Array, relays: string[], strategy: Strategy,
  timeoutMs: number,   // local patience before voting someone absent; never part of the rules
  settleMs: number,    // wait after a round resolves so late copies arrive
  attack?: Attack,
}

/**
 * One tribute. Each tick replays everything seen so far and acts on what the replay is
 * waiting for, so live play cannot drift from the verifier's rules.
 */
export function runPlayer(o: PlayerOptions): Promise<{ result: Result, events: Event[], heard: Heard[] }> {
  const { config, sk, strategy } = o
  const me = getPublicKey(sk), id = gameId(config), R = config.rounds
  const s0 = randomScalar(), chain = makeChain(s0, R)
  const seen = new Map<string, Parsed>()
  const sockets = o.relays.map(url => new WebSocket(url))
  const mine = new Map<number, { move: Move, nonce: string, revealed: boolean }>()
  const voted = new Set<string>()
  const inbox: Talk['inbox'] = [], heard: Heard[] = []
  let silent = false, deciding = false, setupSent = false, lastWords = false
  let latest: Result | null = null   // replay only when a new event arrives
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
    latest = null
    if (p.type === 'chat' && p.to === me) {
      const text = readChat(p, sk)
      if (text !== null) {
        inbox.push({ from: p.pubkey, text })
        heard.push({ round: p.round, from: p.pubkey, to: me, text })
      }
    }
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
    const attack = o.attack?.round === r ? o.attack.kind : null
    if (!setupSent) {
      setupSent = true
      return publish(buildSetup(config, sk, chain.at(-1)!, split(s0, config.roster.length, config.k)))
    }
    if (p.noSetup.length) return

    if (r !== settledRound) { settledRound = r; settleUntil = Date.now() + o.settleMs }
    if (Date.now() < settleUntil) return

    const tell = (to: string, text: string) => publish(buildChat(config, sk, r, to, text))
    if (p.state && !p.alive.includes(me) && !lastWords) {
      lastWords = true
      await strategy(p.state, me, { inbox: [], tell, dying: true })
    }

    if (p.alive.includes(me) && !mine.has(r) && !deciding) {
      deciding = true
      const move = p.state === null ? { a: 'hide' as const } : await strategy(p.state, me, { inbox: inbox.splice(0), tell, dying: false })
      deciding = false
      if (move === null) { silent = true; return }
      const played: Move = attack === 'illegal' ? { a: 'pickup' } : move
      const nonce = randomNonce()
      mine.set(r, { move: played, nonce, revealed: false })
      const state = attack === 'lie-state' ? 'ee'.repeat(32) : p.state === null ? id : stateHash(p.state)
      const commit = buildCommit(config, sk, r, commitment(id, r, me, played, nonce), state)
      if (attack === 'equivocate') {
        send(sockets[0], ['EVENT', commit])
        send(sockets[1], ['EVENT', buildCommit(config, sk, r, commitment(id, r, me, { a: 'hide' }, randomNonce()), state)])
        return
      }
      if (attack === 'forge') {
        const victim = config.roster.find(k => k !== me)
        sockets.forEach(ws => send(ws, ['EVENT', { ...commit, pubkey: victim }]))
      }
      return publish(commit)
    }

    const plan = mine.get(r)
    if (plan && !plan.revealed && !p.noCommit.length) {
      plan.revealed = true
      if (attack === 'withhold') { silent = true; return }
      const changed: Move = plan.move.a === 'hide' ? { a: 'pickup' } : { a: 'hide' }
      return publish(buildReveal(config, sk, r, attack === 'change-move' ? changed : plan.move, plan.nonce, seedForRound(chain, r)))
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
        const result = latest ??= replay([...seen.values()], config)
        if (result.status === 'finished') {
          clearInterval(timer)
          sockets.forEach(ws => ws.close())
          return resolve({ result, events: [...seen.values()].map(p => p.event), heard })
        }
        if (!silent) await act(result)
      } catch (err) {
        clearInterval(timer)
        reject(err)
      } finally {
        busy = false
      }
    }, 20)
  })
}
