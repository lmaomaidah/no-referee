import { mkdirSync, writeFileSync } from 'node:fs'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { randomNonce } from './crypto.ts'
import type { Config } from './protocol.ts'
import { startRelay } from './relay.ts'
import type { Fault } from './relay.ts'
import { runPlayer } from './player.ts'
import type { Attack } from './player.ts'
import { verify } from './verify.ts'
import { scripted } from './bots.ts'
import { llm } from './llm.ts'
import type { Strategy } from './bots.ts'

type Options = {
  rounds?: number, timeoutMs?: number, settleMs?: number,
  attacks?: Record<number, Attack>,   // by index into strategies
  fault?: Fault,                      // applied to the first relay only
}

/** Runs one game on two local relays. The result comes from the log, not from any player. */
export async function runArena(strategies: Strategy[], { rounds = 20, timeoutMs = 30_000, settleMs = 200, attacks = {}, fault }: Options = {}) {
  const sks = strategies.map(() => generateSecretKey())
  const keys = sks.map(sk => getPublicKey(sk))
  const n = keys.length
  const config: Config = { roster: [...keys].sort(), k: Math.floor(n / 2) + 1, rounds, salt: randomNonce() }
  const relays = [await startRelay({ port: 0, fault }), await startRelay({ port: 0 })]
  try {
    const urls = relays.map(r => r.url)
    const done = await Promise.all(sks.map((sk, i) =>
      runPlayer({ config, sk, relays: urls, strategy: strategies[i], timeoutMs, settleMs, attack: attacks[i] })))
    const log = [...new Map(done.flatMap(d => d.events).map(e => [e.id, e])).values()]
    // Plaintext for the demo only: the public log stays ciphertext. Each line is what its reader decrypted.
    const chat = done.flatMap(d => d.heard).sort((a, b) => a.round - b.round)
    return { log, config, keys, chat, result: verify(log, config) }
  } finally {
    await Promise.all(relays.map(r => r.close()))
  }
}

const MODELS = ['nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3.5-super-vl:free', 'recursive/flint-v1.0:free']

/** `node src/arena.ts` plays bots. `node src/arena.ts --ai [rounds]` puts the MODELS in, plus one bot. */
if (import.meta.main) {
  const ai = process.argv[2] === '--ai'
  const rounds = Number(process.argv[3] ?? 20)
  const stats = MODELS.map(() => ({ calls: 0, fallbacks: 0, told: 0, why: {} }))
  if (ai) process.loadEnvFile()
  const key = process.env.OPENROUTER_API_KEY ?? ''
  const players = ai ? [...MODELS.map((m, i) => llm(m, key, stats[i])), scripted] : [scripted, scripted, scripted, scripted]
  const labels = ai ? [...MODELS.map(m => m.split('/')[1].replace(':free', '')), 'Scripted bot'] : players.map((_, i) => `Bot ${i + 1}`)

  const { log, config, keys, chat, result } = await runArena(players, { rounds, timeoutMs: ai ? 90_000 : 30_000 })
  const names = Object.fromEntries(keys.map((k, i) => [k, labels[i]]))
  mkdirSync('out', { recursive: true })
  writeFileSync('out/log.json', JSON.stringify({ config, log }))
  writeFileSync('viewer/replay.json', JSON.stringify({ ...result, names, chat }))
  console.log(`${result.status}: winner ${result.winner && names[result.winner]}, ${result.rounds.length} rounds, ${log.length} events, ${result.cheats.length} cheats`)
  for (const m of chat) console.log(`r${m.round} ${names[m.from]} -> ${names[m.to]}: ${m.text}`)
  if (ai) MODELS.forEach((m, i) => console.log(`${m}: ${stats[i].calls} calls, ${stats[i].told} messages sent, ${stats[i].fallbacks} fell back to the scripted bot ${JSON.stringify(stats[i].why)}`))
}
