import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { randomNonce } from './crypto.ts'
import { gameId } from './protocol.ts'
import type { Config } from './protocol.ts'
import { runPlayer } from './player.ts'
import { verify } from './verify.ts'
import { scripted } from './bots.ts'
import { llm } from './llm.ts'

const usage = `Play one game across several laptops. See docs/TWO-LAPTOPS.md.

  node src/relay.ts                                   host: start the relay
  node src/join.ts key [file]                         everyone: make a private key
  node src/join.ts new ws://HOST:7777 name=pubkey ... host: write game.json
  node src/join.ts play game.json [file] [model]      everyone: play, as a bot or a model`

type Game = { config: Config, relays: string[], names: Record<string, string> }
const fail = (msg: string) => { console.error(msg); process.exit(1) }
const [command, ...args] = process.argv.slice(2)

if (command === 'key') {
  const file = args[0] ?? '.player-key'
  if (existsSync(file)) fail(`${file} already exists. Delete it first if you really want a new key.`)
  const sk = generateSecretKey()
  writeFileSync(file, bytesToHex(sk), { mode: 0o600 })
  console.log(`Saved your private key in ${file}. Never share that file.`)
  console.log(`Send this public key to the host:\n${getPublicKey(sk)}`)
} else if (command === 'new') {
  const [relay, ...players] = args
  if (!relay?.startsWith('ws://') || players.length < 2) fail(usage)
  const pairs = players.map(p => p.split('='))
  if (pairs.some(([, k]) => !/^[0-9a-f]{64}$/.test(k ?? ''))) fail('Each player must look like name=<64 hex characters>.')
  const roster = pairs.map(([, k]) => k).sort()
  if (new Set(roster).size !== roster.length) fail('The same public key appears twice.')
  const config: Config = { roster, k: Math.floor(roster.length / 2) + 1, rounds: 12, salt: randomNonce() }
  const game: Game = { config, relays: [relay], names: Object.fromEntries(pairs.map(([n, k]) => [k, n])) }
  writeFileSync('game.json', JSON.stringify(game, null, 2))
  console.log(`Wrote game.json. Send it to every player.\nGame id, to check everyone has the same file: ${gameId(config)}`)
} else if (command === 'play') {
  const [gameFile, keyFile = '.player-key', model] = args
  if (!gameFile || !existsSync(gameFile)) fail(usage)
  if (!existsSync(keyFile)) fail(`No key in ${keyFile}. Run: node src/join.ts key`)
  const { config, relays, names }: Game = JSON.parse(readFileSync(gameFile, 'utf8'))
  const sk = hexToBytes(readFileSync(keyFile, 'utf8').trim())
  const me = getPublicKey(sk)
  if (!config.roster.includes(me)) fail(`This key is not on the roster in ${gameFile}.`)
  if (model) process.loadEnvFile()

  console.log(`Game id ${gameId(config)}\nPlaying as ${names[me]}. Waiting for the others...`)
  const strategy = model ? llm(model, process.env.OPENROUTER_API_KEY ?? '') : scripted
  const { events, heard } = await runPlayer({ config, sk, relays, strategy, timeoutMs: model ? 90_000 : 30_000, settleMs: 300 })

  // Recomputed from the log, so this laptop checks the result for itself.
  const result = verify(events, config)
  mkdirSync('out', { recursive: true })
  mkdirSync('viewer', { recursive: true })
  writeFileSync('out/log.json', JSON.stringify({ config, log: events }))
  writeFileSync('viewer/replay.json', JSON.stringify({ ...result, names, chat: heard }))
  console.log(`${result.status}: winner ${result.winner && names[result.winner]}, ${result.rounds.length} rounds, ${result.cheats.length} cheats`)
  process.exit(0)
} else {
  console.log(usage)
}
