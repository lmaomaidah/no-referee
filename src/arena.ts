import { mkdirSync, writeFileSync } from 'node:fs'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { randomNonce } from './crypto.ts'
import type { Config } from './protocol.ts'
import { startRelay } from './relay.ts'
import type { Fault } from './relay.ts'
import { runPlayer } from './player.ts'
import type { Attack } from './player.ts'
import { verify } from './verify.ts'
import { gullible, injector, scripted } from './bots.ts'
import { CHAT_URL, keysOf, llm } from './llm.ts'
import type { Keys, Stats } from './llm.ts'
import { MODELS } from './models.ts'
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

export const modelName = (m: string) => m.split('/')[1].replace(':free', '')

/** The demo game: three AI models and the Injector bot, 12 rounds, 15 s per model turn. Used by the CLI and the web app. */
export async function aiGame(keys: Keys, { rounds = 12, waitMs = 15_000 } = {}) {
  const stats: Stats[] = MODELS.map(() => ({ calls: 0, fallbacks: 0, told: 0, why: {} }))
  const players = [...MODELS.map((m, i) => llm(m, keys, stats[i], CHAT_URL, waitMs)), injector]
  const labels = [...MODELS.map(modelName), 'Injector bot']
  const game = await runArena(players, { rounds, timeoutMs: 90_000, settleMs: 300 })
  const names = Object.fromEntries(game.keys.map((k, i) => [k, labels[i]]))
  return { ...game, names, stats, replay: { ...game.result, names, chat: game.chat } }
}

/**
 * `node src/arena.ts` plays bots. `--ai [rounds]` puts the MODELS in, plus one bot.
 * `--demo` is an AI game built to end on time: 12 rounds, 15 s per model, about 39 requests.
 * `--cheat <kind>` is a bot game where one player attacks in round 3, no requests. Kinds are listed in Attack.
 * Keys come from OPENROUTER_API_KEY, comma-separated for several: the next is used when one hits its daily limit.
 */
if (import.meta.main) {
  const demo = process.argv[2] === '--demo'
  const cheat = process.argv[2] === '--cheat' ? (process.argv[3] ?? 'equivocate') as Attack['kind'] : null
  const ai = demo || process.argv[2] === '--ai'
  const rounds = demo || cheat ? 12 : Number(process.argv[3] ?? 20)
  if (ai) process.loadEnvFile()
  const { log, config, names, chat, result, replay, stats } = ai
    ? await aiGame(keysOf(process.env.OPENROUTER_API_KEY), { rounds, waitMs: demo ? 15_000 : 60_000 })
    : await (async () => {
      const labels = ['Bot 1', 'Gullible bot', 'Injector bot', cheat ? 'Cheater bot' : 'Bot 4']
      const game = await runArena([scripted, gullible, injector, scripted], {
        rounds, timeoutMs: cheat ? 5000 : 30_000, settleMs: 300,
        attacks: cheat ? { 3: { kind: cheat, round: 3 } } : {},
      })
      const names = Object.fromEntries(game.keys.map((k, i) => [k, labels[i]]))
      return { ...game, names, stats: [], replay: { ...game.result, names, chat: game.chat } }
    })()
  mkdirSync('out', { recursive: true })
  writeFileSync('out/log.json', JSON.stringify({ config, log }))
  writeFileSync('viewer/replay.json', JSON.stringify(replay))
  console.log(`${result.status}: winner ${result.winner && names[result.winner]}, ${result.rounds.length} rounds, ${log.length} events, ${result.cheats.length} cheats`)
  for (const m of chat) console.log(`r${m.round} ${names[m.from]} -> ${names[m.to]}: ${m.text}`)
  stats.forEach((s, i) => console.log(`${MODELS[i]}: ${s.calls} calls, ${s.told} messages sent, ${s.fallbacks} fell back to the scripted bot ${JSON.stringify(s.why)}`))
}
