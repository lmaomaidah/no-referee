import { legalMove } from './game.ts'
import type { Dir, Move, State } from './game.ts'
import { scripted } from './bots.ts'
import type { Strategy } from './bots.ts'

const DIRS: Dir[] = ['N', 'E', 'S', 'W']

/** Every legal move. A short numbered list keeps small models on the rails. */
export function menu(state: State, me: string): Move[] {
  const all: Move[] = [{ a: 'hide' }, { a: 'pickup' },
    ...DIRS.map(dir => ({ a: 'move', dir }) as Move), ...DIRS.map(dir => ({ a: 'attack', dir }) as Move)]
  return all.filter(m => legalMove(state, me, m))
}

/** Trust boundary: model text in, a menu entry or null out. Nothing else can get through. */
export function choose(reply: string | null, list: Move[]): Move | null {
  const n = Number(reply?.match(/-?\d+/)?.[0])
  return Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1] : null
}

const say = (m: Move) => m.a === 'move' || m.a === 'attack' ? `${m.a} ${m.dir}` : m.a

function prompt(state: State, me: string, list: Move[]) {
  const p = state.players[me], lo = (8 - state.safe) / 2, hi = lo + state.safe - 1
  const rivals = Object.entries(state.players).filter(([k, v]) => k !== me && v.alive)
    .map(([, v]) => `(${v.x},${v.y}) hp ${v.hp}${v.item ? ' ' + v.item : ''}`)
  return [
    'You are a tribute in a last-one-standing game on an 8x8 grid. x grows East, y grows South.',
    `Round ${state.round + 1}. You are at (${p.x},${p.y}), hp ${p.hp}, item ${p.item ?? 'none'}.`,
    `Safe zone: x and y from ${lo} to ${hi}. Outside it you lose 1 hp per round.`,
    `Rivals: ${rivals.join('; ') || 'none'}.`,
    `Supplies: ${state.drops.map(d => `${d.item} at (${d.x},${d.y})`).join('; ') || 'none'}.`,
    'Attacks hit the adjacent cell. Hiding blocks attacks but not the storm.',
    'Choose one:', ...list.map((m, i) => `${i + 1}. ${say(m)}`),
    'Reply with only the number.',
  ].join('\n')
}

export type Stats = { calls: number, fallbacks: number, why: Record<string, number> }

/**
 * An AI tribute on any OpenAI-compatible chat endpoint. If the model fails or answers
 * badly the scripted bot plays that turn, and `stats` records it so results stay honest.
 */
export function llm(model: string, key: string, stats: Stats = { calls: 0, fallbacks: 0, why: {} },
  url = 'https://openrouter.ai/api/v1/chat/completions'): Strategy {
  return async (state, me) => {
    const list = menu(state, me)
    stats.calls++
    let why = 'error'
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 2500, messages: [{ role: 'user', content: prompt(state, me, list) }] }),
        signal: AbortSignal.timeout(60_000),
      })
      const body = res.ok ? await res.json() : null
      const choice = body?.choices?.[0]
      const move = choose(choice?.message?.content ?? null, list)
      if (move) return move
      why = !res.ok ? `http ${res.status}` : body?.error ? `upstream ${body.error.code}` : choice?.finish_reason ?? 'empty'
    } catch (e) {
      why = String((e as any).cause?.code ?? (e as any).cause?.message ?? (e as Error).message)
    }
    stats.fallbacks++
    stats.why[why] = (stats.why[why] ?? 0) + 1
    return scripted(state, me)
  }
}
