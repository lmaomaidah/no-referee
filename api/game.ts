import { aiGame, botGame, modelName } from '../src/arena.ts'
import { findWorkingKey, keysOf } from '../src/llm.ts'
import { MODELS } from '../src/models.ts'
import { ATTACKS } from '../src/player.ts'
import type { Attack } from '../src/player.ts'

const ndjson = { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' }

/** POST /api/game?cheat=<attack>: a 7 to 17 s bot game where the Cheater bot runs that attack. No API keys used. */
async function cheatGame(cheat: string) {
  if (!(ATTACKS as readonly string[]).includes(cheat)) return new Response('unknown attack\n', { status: 400 })
  const game = await botGame(cheat as Attack['kind'])
  return new Response(JSON.stringify({ replay: game.replay, stats: [] }) + '\n', { headers: ndjson })
}

/**
 * POST /api/game runs one live AI game and streams newline-separated JSON:
 * `{joined}` first, `{seconds}` every 5 s, then `{replay, stats}` or `{demo, reason}`.
 * Keys come from OPENROUTER_KEYS (comma-separated) and never reach the browser.
 */
// ponytail: the one-game lock lives in this instance's memory. Vercel can start a second
// instance under load, which would run its own game. Move the lock to a KV store if that matters.
let current: Promise<object> | null = null

async function play() {
  const keys = keysOf(process.env.OPENROUTER_KEYS, process.env.OPENROUTER_API_KEY)
  if (!await findWorkingKey(keys, MODELS[2])) return { demo: true, reason: 'Every API key has used its free requests for today.' }
  const game = await aiGame(keys)
  return { replay: game.replay, stats: game.stats.map((s, i) => ({ model: modelName(MODELS[i]), ...s })) }
}

export async function POST(request: Request) {
  const cheat = new URL(request.url).searchParams.get('cheat')
  if (cheat !== null) return cheatGame(cheat)
  const joined = current !== null
  const game = current ??= play().finally(() => { current = null })
  const started = Date.now(), enc = new TextEncoder()
  const body = new ReadableStream({
    async start(c) {
      const send = (o: object) => c.enqueue(enc.encode(JSON.stringify(o) + '\n'))
      send({ joined })
      const tick = setInterval(() => send({ seconds: Math.round((Date.now() - started) / 1000) }), 5000)
      try {
        send(await game)
      } catch (e) {
        send({ demo: true, reason: `The live game failed: ${(e as Error).message}` })
      } finally {
        clearInterval(tick)
        c.close()
      }
    },
  })
  return new Response(body, { headers: ndjson })
}
