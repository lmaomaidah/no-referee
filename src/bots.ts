import { legalMove } from './game.ts'
import type { Dir, Move, State } from './game.ts'

/** Private chat. It reaches the next round's inbox and never affects the rules. */
export type Talk = {
  inbox: { from: string, text: string }[],
  tell: (to: string, text: string) => void,
  dying: boolean,   // true once, after death: say last words, the returned move is ignored
}

/** Picks a move. null means go silent for the rest of the game. */
export type Strategy = (state: State, me: string, talk: Talk) => Move | null | Promise<Move | null>

const STEP: Record<Dir, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] }
const DIRS = Object.keys(STEP) as Dir[]

/** Grab what is underfoot, hit what is adjacent, go for nearby supplies, otherwise the centre. */
export const scripted: Strategy = (state, me) => {
  const p = state.players[me]
  if (legalMove(state, me, { a: 'pickup' })) return { a: 'pickup' }
  const enemy = Object.entries(state.players).filter(([k, v]) => k !== me && v.alive).map(([, v]) => v)
  const dir = DIRS.find(d => enemy.some(e => e.x === p.x + STEP[d][0] && e.y === p.y + STEP[d][1]))
  if (dir) return { a: 'attack', dir }
  const dist = (x: number, y: number, g: { x: number, y: number }) => Math.abs(x - g.x) + Math.abs(y - g.y)
  const lo = (8 - state.safe) / 2, hi = lo + state.safe - 1
  const supplies = state.drops.filter(d => d.x >= lo && d.x <= hi && d.y >= lo && d.y <= hi && dist(p.x, p.y, d) <= 5)
  const goal = supplies.sort((a, b) => dist(p.x, p.y, a) - dist(p.x, p.y, b))[0] ?? { x: 3.5, y: 3.5 }
  const after = (d: Dir) => dist(p.x + STEP[d][0], p.y + STEP[d][1], goal)
  const best = [...DIRS].sort((a, b) => after(a) - after(b))[0]
  const move: Move = { a: 'move', dir: best }
  return after(best) < dist(p.x, p.y, goal) && legalMove(state, me, move) ? move : { a: 'hide' }
}

/** Plays normally, then stops answering from `round` on. */
export const quitter = (round: number): Strategy => (state, me, talk) =>
  state.round + 1 >= round ? null : scripted(state, me, talk)
