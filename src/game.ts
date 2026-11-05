import { canonical, sha256hex } from './crypto.ts'

export type Dir = 'N' | 'E' | 'S' | 'W'
export type Move = { a: 'move', dir: Dir } | { a: 'attack', dir: Dir } | { a: 'hide' } | { a: 'pickup' }
export type Item = 'knife' | 'shield'
export type State = {
  round: number, // last resolved round: spawn is round 0, so legalMove judges a move for round + 1
  safe: number, // safe zone width: 8, 6, 4 or 2
  players: Record<string, { x: number, y: number, hp: number, item: Item | null, alive: boolean, hiding: boolean }>,
  drops: { x: number, y: number, item: Item | 'medkit' }[],
  fallen: string[], // who died in this round, sorted. winner needs it; ejected players are never in it
}
type Cell = { x: number, y: number }

const SIZE = 8
const MAX_HP = 3
const DELTA = new Map<unknown, Cell>([['N', { x: 0, y: -1 }], ['E', { x: 1, y: 0 }], ['S', { x: 0, y: 1 }], ['W', { x: -1, y: 0 }]])

const same = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y
const step = (c: Cell, dir: Dir): Cell => ({ x: c.x + DELTA.get(dir)!.x, y: c.y + DELTA.get(dir)!.y })
const onGrid = (c: Cell) => c.x >= 0 && c.x < SIZE && c.y >= 0 && c.y < SIZE
/** Counter-mode draw in [0, n). Bias is about n / 2^256. */
const draw = (random: string, counter: number, n: number) =>
  Number(BigInt('0x' + sha256hex(`${random}:${counter}`)) % BigInt(n))
const grid = () => Array.from({ length: SIZE * SIZE }, (_, i) => ({ x: i % SIZE, y: Math.floor(i / SIZE) }))

export function spawn(roster: string[], random: string): State {
  const cells = grid()
  const players: State['players'] = {}
  for (const [i, k] of [...roster].sort().entries()) {
    const [{ x, y }] = cells.splice(draw(random, i, cells.length), 1)
    players[k] = { x, y, hp: MAX_HP, item: null, alive: true, hiding: false }
  }
  return { round: 0, safe: SIZE, players, drops: [], fallen: [] }
}

/** Takes unchecked reveal content at runtime, so it must answer false on any junk. */
export function legalMove(state: State, pubkey: string, move: Move): boolean {
  const p = state.players[pubkey]
  if (!p?.alive) return false
  switch (move?.a) {
    case 'hide': return true
    case 'pickup': return state.drops.some(d => same(d, p))
    case 'attack': return DELTA.has(move.dir)
    case 'move': return DELTA.has(move.dir) && onGrid(step(p, move.dir))
    default: return false
  }
}

export function applyRound(state: State, moves: Record<string, Move | null>, random: string): State {
  const s = structuredClone(state)
  const P = s.players
  s.round++
  s.fallen = []
  const alive = Object.keys(P).filter(k => P[k].alive).sort()

  const act: Record<string, Move | null> = {}
  for (const k of alive) {
    const m = moves[k]
    act[k] = m && legalMove(state, k, m) ? m : null
    P[k].hiding = !act[k] || act[k].a === 'hide'
  }

  // Moves. Everyone aims, then bounces repeat until stable: a mover goes home if another
  // player ends on its target, or if the two would swap cells head-on.
  const dest: Record<string, Cell> = {}
  for (const k of alive) {
    const m = act[k]
    dest[k] = m?.a === 'move' ? step(P[k], m.dir) : P[k]
  }
  for (;;) {
    const bounced = alive.filter(k => !same(dest[k], P[k]) && alive.some(q => q !== k
      && (same(dest[q], dest[k]) || (same(dest[q], P[k]) && same(dest[k], P[q])))))
    if (!bounced.length) break
    for (const k of bounced) dest[k] = P[k]
  }
  for (const k of alive) { const { x, y } = dest[k]; P[k].x = x; P[k].y = y }

  for (const k of alive) {
    if (act[k]?.a !== 'pickup') continue
    const [d] = s.drops.splice(s.drops.findIndex(d => same(d, P[k])), 1)
    if (d.item === 'medkit') P[k].hp = Math.min(MAX_HP, P[k].hp + 1)
    else P[k].item = d.item
  }

  // Attacks. Summed first so that order cannot matter; a shield takes 1 off the total, once.
  const hits: Record<string, number> = {}
  for (const k of alive) {
    const m = act[k]
    if (m?.a !== 'attack') continue
    const cell = step(P[k], m.dir)
    for (const q of alive) {
      if (same(P[q], cell) && !P[q].hiding) hits[q] = (hits[q] ?? 0) + (P[k].item === 'knife' ? 2 : 1)
    }
  }
  for (const [q, dmg] of Object.entries(hits)) {
    const shield = P[q].item === 'shield'
    P[q].hp -= shield ? dmg - 1 : dmg
    if (shield) P[q].item = null
  }

  // Storm. The new width applies in the round it shrinks; hp is not clamped, see winner.
  s.safe = Math.max(2, SIZE - 2 * Math.floor(s.round / 5))
  const margin = (SIZE - s.safe) / 2
  const inZone = (c: Cell) => [c.x, c.y].every(v => v >= margin && v < SIZE - margin)
  for (const k of alive) if (P[k].hp > 0 && !inZone(P[k])) P[k].hp--

  for (const k of alive) {
    if (P[k].hp > 0) continue
    P[k].alive = false
    s.fallen.push(k)
  }

  if (s.round % 3 === 0) {
    const taken = [...s.drops, ...alive.map(k => P[k]).filter(p => p.alive)]
    const free = grid().filter(c => !taken.some(t => same(t, c)))
    if (free.length) {
      const item = (['knife', 'shield', 'medkit'] as const)[draw(random, 0, 3)]
      s.drops.push({ ...free[draw(random, 1, free.length)], item })
    }
  }
  return s
}

export function stateHash(state: State): string {
  return sha256hex(canonical(state))
}

/**
 * `random` is the random of the round `state` ended, `lastRound` is true once round R has resolved.
 * null means play on, or that nobody is left to win (everyone ejected): check who is alive.
 */
export function winner(state: State, random: string, lastRound: boolean): string | null {
  const alive = Object.keys(state.players).filter(k => state.players[k].alive)
  if (alive.length === 1) return alive[0]
  if (alive.length > 1 && !lastRound) return null
  const pool = alive.length ? alive : state.fallen
  if (!pool.length) return null
  const top = Math.max(...pool.map(k => state.players[k].hp))
  const hash = (k: string) => sha256hex(random + k)
  return pool.filter(k => state.players[k].hp === top).sort((a, b) => (hash(a) < hash(b) ? -1 : 1))[0]
}
