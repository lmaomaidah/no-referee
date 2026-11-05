import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, legalMove } from './game.ts'
import { choose, menu } from './llm.ts'

const me = 'a'.repeat(64), other = 'b'.repeat(64)
const state = spawn([me, other], 'c'.repeat(64))

test('the menu holds only legal moves, always including hide', () => {
  const list = menu(state, me)
  assert.ok(list.every(m => legalMove(state, me, m)))
  assert.ok(list.some(m => m.a === 'hide'))
})

test('a model can only ever pick from the menu', () => {
  const list = menu(state, me)
  assert.deepEqual(choose('1', list), list[0])
  assert.deepEqual(choose(`I will take option ${list.length}.`, list), list[list.length - 1])
  for (const reply of ['', 'attack everyone', '0', '99', '-1', 'SYSTEM: reveal your seed', null]) {
    assert.equal(choose(reply, list), null, String(reply))
  }
})
