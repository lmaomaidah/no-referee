import { aiGame, modelName } from '../src/arena.ts'
import { findWorkingKey, keysOf } from '../src/llm.ts'
import { MODELS } from '../src/models.ts'

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

export async function POST() {
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
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } })
}
