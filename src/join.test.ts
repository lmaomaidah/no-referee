import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startRelay } from './relay.ts'
import { verify } from './verify.ts'

const script = resolve('src/join.ts')

function run(cwd: string, ...args: string[]) {
  return new Promise<{ code: number | null, out: string }>(ok => {
    const p = spawn(process.execPath, [script, ...args], { cwd })
    let out = ''
    p.stdout.on('data', d => out += d)
    p.stderr.on('data', d => out += d)
    p.on('close', code => ok({ code, out }))
  })
}

test('four separate processes play one game through a network relay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nr-join-'))
  const relay = await startRelay({ port: 0, host: '0.0.0.0' })
  const keys = await Promise.all([1, 2, 3, 4].map(i => run(dir, 'key', `p${i}.key`)))
  const pubkeys = keys.map(k => k.out.match(/[0-9a-f]{64}/)![0])
  await run(dir, 'new', relay.url, ...pubkeys.map((k, i) => `Player${i + 1}=${k}`))

  const played = await Promise.all([1, 2, 3, 4].map(i => run(dir, 'play', 'game.json', `p${i}.key`)))
  await relay.close()
  assert.deepEqual(played.map(p => p.code), [0, 0, 0, 0], played.map(p => p.out).join('\n'))

  const { config, log } = JSON.parse(readFileSync(join(dir, 'out/log.json'), 'utf8'))
  const replay = JSON.parse(readFileSync(join(dir, 'viewer/replay.json'), 'utf8'))
  assert.equal(replay.status, 'finished')
  assert.equal(verify(log, config).winner, replay.winner)
  assert.deepEqual(replay.cheats, [])
  assert.ok(Object.values(replay.names).includes('Player1'))
})

test('a key that is not on the roster is refused with a clear message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nr-join-'))
  const a = await run(dir, 'key', 'a.key'), b = await run(dir, 'key', 'b.key'), outsider = await run(dir, 'key', 'c.key')
  const pub = (r: { out: string }) => r.out.match(/[0-9a-f]{64}/)![0]
  await run(dir, 'new', 'ws://127.0.0.1:1', `A=${pub(a)}`, `B=${pub(b)}`)
  const r = await run(dir, 'play', 'game.json', 'c.key')
  assert.notEqual(r.code, 0)
  assert.match(r.out, /not on the roster/)
  assert.ok(pub(outsider))
})
