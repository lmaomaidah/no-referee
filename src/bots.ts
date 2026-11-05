import { legalMove } from './game.ts'
import type { Dir, Move, State } from './game.ts'

/** Picks a move. null means go silent for the rest of the game. */
export type Strategy = (state: State, me: string) => Move | null | Promise<Move | null>

const STEP: Record<Dir, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] }
const DIRS = Object.keys(STEP) as Dir[]

/** Grab what is underfoot, hit what is adjacent, otherwise walk to the centre. */
export const scripted: Strategy = (state, me) => {
  const p = state.players[me]
  if (legalMove(state, me, { a: 'pickup' })) return { a: 'pickup' }
  const enemy = Object.entries(state.players).filter(([k, v]) => k !== me && v.alive).map(([, v]) => v)
  const dir = DIRS.find(d => enemy.some(e => e.x === p.x + STEP[d][0] && e.y === p.y + STEP[d][1]))
  if (dir) return { a: 'attack', dir }
  const toCentre = (d: Dir) => Math.abs(p.x + STEP[d][0] - 3.5) + Math.abs(p.y + STEP[d][1] - 3.5)
  const best = [...DIRS].sort((a, b) => toCentre(a) - toCentre(b))[0]
  const move: Move = { a: 'move', dir: best }
  return toCentre(best) < Math.abs(p.x - 3.5) + Math.abs(p.y - 3.5) && legalMove(state, me, move) ? move : { a: 'hide' }
}

/** Plays normally, then stops answering from `round` on. */
export const quitter = (round: number): Strategy => (state, me) =>
  state.round + 1 >= round ? null : scripted(state, me)
