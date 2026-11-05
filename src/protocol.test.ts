import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { N, canonical, commitment, combine, makeChain, randomNonce, randomScalar, split } from './crypto.ts'
import {
  KIND, gameId, parse, decryptShare,
  buildSetup, buildCommit, buildReveal, buildRecover, buildChat,
} from './protocol.ts'
import type { Config } from './protocol.ts'

const sks = Array.from({ length: 4 }, generateSecretKey)
  .sort((a, b) => (getPublicKey(a) < getPublicKey(b) ? -1 : 1))
const roster = sks.map(getPublicKey)
const config: Config = { roster, k: 3, rounds: 5, salt: 'salt' }
const [sk, pub] = [sks[0], roster[0]]
const hex = 'a'.repeat(64)
const hide = { a: 'hide' } as const

const raw = (content: string, tags: string[][] = [['g', gameId(config)], ['r', '1']], kind: number = KIND.commit, key = sk) =>
  finalizeEvent({ kind, created_at: 1, tags, content }, key)
const setup = () => {
  const s0 = randomScalar()
  return { s0, event: buildSetup(config, sk, makeChain(s0, config.rounds).at(-1)!, split(s0, 4, 3)) }
}

test('gameId: ignores key order, changes with config', () => {
  assert.equal(gameId(config), gameId({ salt: 'salt', rounds: 5, k: 3, roster }))
  assert.notEqual(gameId(config), gameId({ ...config, salt: 'other' }))
})

test('kinds are 7300-7304', () => {
  assert.deepEqual(Object.values(KIND), [7300, 7301, 7302, 7303, 7304])
})

test('every builder round-trips through parse', () => {
  const s = parse(setup().event, config)
  assert.ok(s?.type === 'setup' && s.round === 0 && s.pubkey === pub)
  assert.deepEqual(Object.keys(s.shares).sort(), [...roster].sort())

  const c = parse(buildCommit(config, sk, 2, hex, hex), config)
  assert.ok(c?.type === 'commit' && c.round === 2 && c.h === hex && c.state === hex)

  const nonce = randomNonce()
  const r = parse(buildReveal(config, sk, 2, { a: 'move', dir: 'N' }, nonce, hex), config)
  assert.ok(r?.type === 'reveal' && r.nonce === nonce && r.seed === hex)
  assert.deepEqual(r.move, { a: 'move', dir: 'N' })

  const v = parse(buildRecover(config, sk, 2, roster[1], { x: 1, y: hex }), config)
  assert.ok(v?.type === 'recover' && v.target === roster[1])
  assert.deepEqual(v.share, { x: 1, y: hex })

  const m = parse(buildChat(config, sk, 2, roster[1], 'truce?'), config)
  assert.ok(m?.type === 'chat' && m.to === roster[1])
  assert.equal(nip44.decrypt(m.ct, nip44.getConversationKey(sks[1], pub)), 'truce?')
})

test('every legal move shape parses', () => {
  for (const move of [hide, { a: 'pickup' }, { a: 'attack', dir: 'W' }, { a: 'move', dir: 'S' }] as const)
    assert.ok(parse(buildReveal(config, sk, 1, move, hex, hex), config))
})

test('parse output hashes back to the commitment', () => {
  const nonce = randomNonce(), h = commitment(gameId(config), 1, pub, hide, nonce)
  const r = parse(buildReveal(config, sk, 1, hide, nonce, hex), config)
  assert.ok(r?.type === 'reveal')
  assert.equal(commitment(gameId(config), r.round, r.pubkey, r.move, r.nonce), h)
})

test('decryptShare: every holder gets its own share, and they combine to s0', () => {
  const { s0, event } = setup(), s = parse(event, config)
  assert.ok(s?.type === 'setup')
  const shares = sks.map(key => decryptShare(s, key, config))
  assert.deepEqual(shares.map(x => x?.x), [1, 2, 3, 4])
  assert.equal(combine(shares.slice(1).map(x => x!)), s0)
})

test('decryptShare: null for outsiders and for garbage, never throws', () => {
  const s = parse(setup().event, config)
  assert.ok(s?.type === 'setup')
  assert.equal(decryptShare(s, generateSecretKey(), config), null)
  assert.equal(decryptShare({ ...s, shares: { ...s.shares, [roster[1]]: 'garbage' } }, sks[1], config), null)
})

test('decryptShare: null when the dealer encrypts a share with the wrong x or bad y', () => {
  const conv = nip44.getConversationKey(sk, roster[1])
  const s = parse(setup().event, config)
  assert.ok(s?.type === 'setup')
  for (const share of [{ x: 3, y: hex }, { x: 2, y: 'zz' }, 'nope'])
    assert.equal(decryptShare({ ...s, shares: { ...s.shares, [roster[1]]: nip44.encrypt(canonical(share), conv) } }, sks[1], config), null)
})

test('parse rejects tampered content, even on an object verifyEvent has cached', () => {
  const e = buildCommit(config, sk, 1, hex, hex)
  const content = canonical({ h: 'b'.repeat(64), state: hex })
  assert.equal(parse({ ...e, content }, config), null)
  e.content = content
  assert.equal(parse(e, config), null)
  assert.equal(parse(JSON.parse(JSON.stringify(e)), config), null)
})

test('parse rejects a wrong signature', () => {
  const e = buildCommit(config, sk, 1, hex, hex)
  assert.equal(parse({ ...e, sig: buildCommit(config, sk, 2, hex, hex).sig }, config), null)
  assert.equal(parse({ ...e, pubkey: roster[1] }, config), null)
})

test('parse rejects non-roster pubkey', () => {
  assert.equal(parse(buildCommit(config, generateSecretKey(), 1, hex, hex), config), null)
})

test('parse rejects wrong game', () => {
  assert.equal(parse(buildCommit({ ...config, salt: 'other' }, sk, 1, hex, hex), config), null)
})

test('parse rejects bad tags', () => {
  const g = ['g', gameId(config)]
  for (const tags of [[], [g], [['r', '1']], [g, ['r', '6']], [g, ['r', '-1']], [g, ['r', '01']],
    [g, ['r', '1.5']], [g, ['r', '1'], ['r', '2']], [g, ['r', '1'], ['g', hex]], [g, ['r', '1', 'x']]])
    assert.equal(parse(raw(canonical({ h: hex, state: hex }), tags), config), null, JSON.stringify(tags))
})

test('parse rejects garbage JSON and non-events without throwing', () => {
  for (const c of ['not json', '', 'null', '[]', '1', '"x"', '{', '1e999', '{"h":1e999}'])
    assert.equal(parse(raw(c), config), null, c)
  for (const e of [null, undefined, 1, 'x', [], {}, { tags: 1 }, { kind: 7301, tags: [[1]] }])
    assert.equal(parse(e, config), null)
  assert.equal(parse(raw('['.repeat(200000) + ']'.repeat(200000)), config), null)
})

test('parse rejects a kind outside 7300-7304', () => {
  assert.equal(parse(raw(canonical({ h: hex, state: hex }), undefined, 1), config), null)
})

test('parse rejects content that is valid JSON but not canonical', () => {
  assert.ok(parse(raw(`{"h":"${hex}","state":"${hex}"}`), config))
  assert.equal(parse(raw(`{"state":"${hex}","h":"${hex}"}`), config), null)
  assert.equal(parse(raw(`{"h": "${hex}","state":"${hex}"}`), config), null)
  assert.equal(parse(raw(`{"h":"${'b'.repeat(64)}","h":"${hex}","state":"${hex}"}`), config), null)
})

test('parse rejects wrong shapes for commit', () => {
  for (const c of [{ h: hex }, { h: hex, state: hex, x: 1 }, { h: 'zz', state: hex }, { h: hex.toUpperCase(), state: hex },
    { h: [hex], state: hex }, { h: hex, state: 1 }])
    assert.equal(parse(raw(canonical(c)), config), null, canonical(c))
})

test('parse rejects wrong shapes for reveal, including case-flipped seeds', () => {
  const bad = [
    { move: hide, nonce: hex, seed: hex.toUpperCase() }, { move: hide, nonce: hex.toUpperCase(), seed: hex },
    { move: hide, nonce: hex }, { move: null, nonce: hex, seed: hex }, { move: 'hide', nonce: hex, seed: hex },
    { move: { a: 'fly' }, nonce: hex, seed: hex }, { move: { a: 'move' }, nonce: hex, seed: hex },
    { move: { a: 'move', dir: 'X' }, nonce: hex, seed: hex }, { move: { a: 'hide', dir: 'N' }, nonce: hex, seed: hex },
  ]
  for (const c of bad)
    assert.equal(parse(raw(canonical(c), undefined, KIND.reveal), config), null, canonical(c))
})

test('parse rejects wrong shapes for setup', () => {
  const g = [['g', gameId(config)], ['r', '0']]
  const shares = Object.fromEntries(roster.map(p => [p, 'ct']))
  assert.ok(parse(raw(canonical({ tip: hex, shares }), g, KIND.setup), config))
  const { [roster[3]]: _, ...missing } = shares
  for (const c of [{ tip: 'zz', shares }, { tip: hex, shares: missing }, { tip: hex, shares: { ...shares, [hex]: 'ct' } },
    { tip: hex, shares: { ...shares, [roster[0]]: 1 } }, { tip: hex, shares: [] }])
    assert.equal(parse(raw(canonical(c), g, KIND.setup), config), null, canonical(c))
  assert.equal(parse(raw(canonical({ tip: hex, shares }), undefined, KIND.setup), config), null, 'setup outside round 0')
})

test('parse rejects wrong shapes for recover', () => {
  const nHex = N.toString(16)
  for (const c of [
    { target: hex, share: { x: 1, y: hex } }, { target: roster[1], share: { x: 2, y: hex } },
    { target: roster[1], share: { x: 1.5, y: hex } }, { target: roster[1], share: { x: '1', y: hex } },
    { target: roster[1], share: { x: 1, y: 'zz' } }, { target: roster[1], share: { x: 1, y: nHex } },
    { target: roster[1], share: { x: 1 } }, { target: roster[1], share: null }, { target: roster[1] },
  ]) assert.equal(parse(raw(canonical(c), undefined, KIND.recover), config), null, canonical(c))
})

test('parse rejects wrong shapes for chat', () => {
  for (const c of [{ to: hex, ct: 'x' }, { to: roster[1], ct: 1 }, { to: roster[1] }])
    assert.equal(parse(raw(canonical(c), undefined, KIND.chat), config), null, canonical(c))
})
