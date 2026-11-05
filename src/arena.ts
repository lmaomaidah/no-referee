import { mkdirSync, writeFileSync } from 'node:fs'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { randomNonce } from './crypto.ts'
import type { Config } from './protocol.ts'
import { startRelay } from './relay.ts'
import { runPlayer } from './player.ts'
import { verify } from './verify.ts'
import { scripted } from './bots.ts'
import type { Strategy } from './bots.ts'

type Options = { rounds?: number, timeoutMs?: number, settleMs?: number }

/** Runs one game on two local relays. The result comes from the log, not from any player. */
export async function runArena(strategies: Strategy[], { rounds = 20, timeoutMs = 30_000, settleMs = 200 }: Options = {}) {
  const sks = strategies.map(() => generateSecretKey())
  const keys = sks.map(sk => getPublicKey(sk))
  const n = keys.length
  const config: Config = { roster: [...keys].sort(), k: Math.floor(n / 2) + 1, rounds, salt: randomNonce() }
  const relays = [await startRelay({ port: 0 }), await startRelay({ port: 0 })]
  try {
    const urls = relays.map(r => r.url)
    const done = await Promise.all(sks.map((sk, i) =>
      runPlayer({ config, sk, relays: urls, strategy: strategies[i], timeoutMs, settleMs })))
    const log = [...new Map(done.flatMap(d => d.events).map(e => [e.id, e])).values()]
    return { log, config, keys, result: verify(log, config) }
  } finally {
    await Promise.all(relays.map(r => r.close()))
  }
}

if (import.meta.main) {
  const { log, config, keys, result } = await runArena([scripted, scripted, scripted, scripted])
  const names = Object.fromEntries(keys.map((k, i) => [k, `Bot ${i + 1}`]))
  mkdirSync('out', { recursive: true })
  writeFileSync('out/log.json', JSON.stringify({ config, log }))
  writeFileSync('viewer/replay.json', JSON.stringify({ ...result, names }))
  console.log(`${result.status}: winner ${result.winner && names[result.winner]}, ${result.rounds.length} rounds, ${log.length} events, ${result.cheats.length} cheats`)
}
