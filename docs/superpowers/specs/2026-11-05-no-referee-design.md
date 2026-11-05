# No Referee: design

Source: `No Referee: Trustless Hunger Games for AI Agents` proposal (2026-10-25).
The user skipped the design questions and asked to start, so every choice below
that is not in the proposal is the builder's call and is marked **(call)**.

## Intent

4-6 AI agents play a last-tribute-standing grid game with no referee and no game
server. Cryptography enforces the rules. We then attack the protocol and show
that cheats are caught. Graded as an Information Security course project; the
crypto and the red-team results matter more than game depth.

Goals: full game with scripted bots by 2026-11-08, AI agents and red team on top,
replay viewer, report, live demo by 2026-11-30.

Non-goals: hidden positions with proofs, network DoS defence, Sybil defence
(roster is fixed). Feldman VSS is a stretch goal only.

Anti-goal: any component whose word must be trusted. If a result cannot be
recomputed from the signed log alone, it is a bug.

## Changes from the proposal

- **No Ollama.** User's laptop has no GPU (i5-8265U, 16 GB). Agents call hosted
  models through OpenRouter's OpenAI-compatible chat endpoint, one `fetch` function,
  key in `.env`. Gemini was planned too, but both keys tried return 403 without billing. "Each a different model family"
  still holds. The report must say "hosted models", not "local models".
- **Self-written relay (call).** Docker is not installed. Relays are untrusted by
  design, so a small NIP-01 relay on `ws` is enough, and it gives us a hook to
  drop, delay and reorder events for the red team.
- **One honest gap in the proposal's claim (call).** "Every cheat traced to its
  key" cannot hold for forgery: a forged event has no valid signature, so there
  is no key to trace. Forgeries are rejected and the impersonated player is not
  blamed. The report should word it that way.

## Stack

Node 24 runs `.ts` directly (type stripping, so erasable syntax only: no enums,
no parameter properties). Tests use `node --test`. Dependencies: `nostr-tools`,
`@noble/hashes`, `ws`. Dev: `typescript`, `@types/node`, `@types/ws` for
`tsc --noEmit`. `crypto.ts`, `protocol.ts`, `game.ts` and `verify.ts` must not import
`node:*`, so they can run in a browser later.

## Files

| File | Job |
|---|---|
| `src/crypto.ts` | canonical JSON, sha256, commitments, seed chain, Shamir |
| `src/protocol.ts` | event kinds, build/parse/validate signed events |
| `src/game.ts` | pure rules: `spawn`, `applyRound`, `stateHash` |
| `src/verify.ts` | replay: event log in, winner and cheats out |
| `src/relay.ts` | minimal NIP-01 relay with fault hooks |
| `src/player.ts` | runs one tribute's protocol loop against relays |
| `src/arena.ts` | starts relays and players, saves the log |
| `src/join.ts` | one player per machine, against a shared relay |
| `src/bots.ts` | scripted, injecting and gullible strategies. Attacks live in `src/player.ts` |
| `src/llm.ts` | the AI strategy, chat voice and last words |
| `src/models.ts` | free models in use |
| `src/injection.ts` | single-turn prompt-injection trials |
| `viewer/index.html` | replay viewer |

## Protocol

### Setup

`config = { roster: sorted hex pubkeys, k, rounds, salt }`.
`gameId = sha256hex(canonical(config))`. `n = roster.length`.
`k = floor(n/2) + 1` **(call)**: n=4 gives 3, n=5 gives 3, n=6 gives 4.

Security assumption: fewer than `k` players collude, and at least `k` roster
members other than the absent target stay online (a target never contributes its
own share). Eliminated players keep running as share holders until the
game ends. If `k` cannot be reached the game stops and the verifier reports
`stalled`. Nobody can force progress, which is the honest ceiling of k-of-n.

### Seed chain, one Shamir sharing per game (call)

The proposal commits to a random seed per round. Instead each player commits once:

```
s0 = random scalar in [1, N)         N = secp256k1 group order
c_0 = s0 as 32 bytes big-endian;  c_(i+1) = sha256(c_i)
tip = c_(R+2)                        R = config.rounds
seed for round r = c_(R+1-r)         r = 0..R
check: sha256 applied (r+1) times to seed_r equals tip
```

Revealing round r's seed gives nothing about later rounds because hashes run
backwards. Sharing `s0` once up front recovers every remaining seed of a quitter,
so there is one sharing per game, not one per round. Shamir runs over the field
of size N (so Feldman VSS can be added on secp256k1 later). Share x-coordinates
are `index in sorted roster + 1`.

A recovered `s0` is checked against `tip`. A mismatch means someone gave a bad
share. Without Feldman we cannot say who; the verifier tries `k`-subsets of the
published shares in sorted order and takes the first that matches `tip`.

If no subset matches, the seed is unrecoverable: the dealer gave bad shares, or
voters published bad ones. The game must not stall on this, or a cheater gets a
free abort whenever a round goes badly. Rule **(call)**: the target is ejected as
`absent` as usual and its seed for that round is the constant
`sha256hex(canonical(['no-seed', gameId, round, target]))`.

`// ponytail:` known ceiling. A player who dealt bad shares can still choose between
revealing and withholding after seeing the other seeds. That is one bit of bias on
one round, once, paid for by being ejected. Feldman VSS plus a commitment binding
`s0` to `tip` is the upgrade: it would pin the blame on the dealer or the bad voter.
The report must state this limit.

### Events

All are regular Nostr events (kinds 7300-7304) signed Schnorr by the player, tags
`["g", gameId]`, `["r", String(round)]`, content is canonical JSON.

| Kind | Name | Content |
|---|---|---|
| 7300 | setup | `{ tip, shares: { [pubkey]: nip44 ciphertext } }` (round 0 tag) |
| 7301 | commit | `{ h, state }` |
| 7302 | reveal | `{ move, nonce, seed }` |
| 7303 | recover | `{ target, share: { x, y } }` x number, y hex |
| 7304 | chat | `{ to, ct }` nip44 ciphertext |

`h = sha256hex(canonical([gameId, round, pubkey, move, nonce]))`, nonce 32 random
bytes hex. Binding the round, pubkey and game stops replaying an old commitment
or copying another player's. `state = stateHash` of the state at round start, so
any fork shows up in the log. In round 0 no state exists yet, so `state = gameId`.

### Round flow

Round 0 is an ordinary round where the only legal move is `hide`; its randomness
sets spawn positions. Rounds 1..R are play.

1. Each alive player commits.
2. Once a commit from every alive player is seen (or they are ejected), each
   reveals. An honest player never reveals earlier.
3. `random_r = sha256(canonical([gameId, r, seeds of players alive at round start,
   sorted by pubkey]))`.
4. Everyone applies `applyRound`. Dead players stop committing but keep listening.

Commits and reveals happen after the previous round's randomness, and a round's
randomness only affects the end of that round, so moves cannot depend on it.

### No clock: quorum replaces deadlines (call)

Nostr `created_at` is self-reported and relays can delay, so no rule in the log
may depend on time. Timeouts are local: a player that has waited past its local
timeout publishes a `recover` event for the absent target, which is both its vote
and its decrypted share. `k` valid recover events from distinct roster members for
`(target, round)` eject the target in that round. The same `k` shares rebuild its
seed, so quitting cannot change `random_r`. This is why the last-revealer attack
fails. Below `k`, votes do nothing, so a colluding minority cannot eject anyone.

Quorum beats a late reveal: if quorum exists, the target's move is void even if
its reveal is in the log. The seed is the same either way. It is labelled
`absent`, not `cheat`. Local timeouts: 30 s bots, 90 s LLM **(call)**.

### Cheat rules (pure functions of the log)

| Type | Detection | Evidence |
|---|---|---|
| `equivocation` | two different valid events, same pubkey, kind, g, r (for recover also same target) | both event ids |
| `bad-reveal` | reveal does not match commit, or seed fails the chain check | commit and reveal ids |
| `illegal-move` | reveal matches but `legalMove` is false | reveal id |
| `state-fork` | commit `state` differs from the verifier's stateHash | commit id |
| `absent` | k recover events | recover ids |

Any of these ejects the player in that round with its move void. The seed comes
from a chain-valid reveal if one exists, else from recovery, so honest players also
vote `recover` against a `bad-reveal`.

Everything `parse` refuses (invalid signature, non-roster pubkey, malformed content
even from a roster member) is dropped and counted in `rejected`. Nobody is accused
for them. A signed reveal with a malformed move is therefore dropped, so that player
ends up `absent`, not `illegal-move`: ejected and traced either way. An honest player's event is never dropped because of
someone else's forgery.

Players publish to every relay and rebroadcast every valid event they see to
every relay, and wait a short settle delay before applying a round.
`// ponytail:` settle delay is a heuristic. A relay partition longer than the
delay can fork live play from the replay; `state` in the next commit exposes it.

### Verifier

`verify(events, config)` returns

```ts
{ status: 'finished' | 'stalled', winner: string | null,
  rounds: { round, random, moves, state }[],
  cheats: { pubkey, round, type, evidence: string[] }[], rejected: number }
```

Order-independent: any permutation of the same event set gives the same result.

## Game rules (call where the proposal is silent)

8x8 grid, `x,y` in 0..7, `N` is y-1. Default 20 rounds. HP 3. Spawns are distinct
cells drawn from randomness, one tribute per cell.

```ts
type Dir = 'N'|'E'|'S'|'W'
type Move = {a:'move',dir:Dir} | {a:'attack',dir:Dir} | {a:'hide'} | {a:'pickup'}
type Item = 'knife'|'shield'
type State = { round: number, safe: number, // safe zone width: 8, 6, 4 or 2
  players: Record<string, { x:number, y:number, hp:number, item:Item|null, alive:boolean, hiding:boolean }>,
  drops: { x:number, y:number, item:Item|'medkit' }[],
  fallen: string[] } // died in the latest applyRound, for the last-two-die tie break
```

`game.ts` exports `spawn(roster, random): State`,
`applyRound(state, moves: Record<pubkey, Move|null>, random): State` (null means
void, and that player is treated as hiding), `legalMove(state, pubkey, move): boolean`,
`stateHash(state): string`, `winner(state, random, lastRound: boolean): string|null`. A player holds one item; a pickup
replaces it. Ejected players are removed by setting `alive: false` before
`applyRound` runs. `random` is a hex string.

Resolution order each round: moves, simultaneously (two players entering one cell
both bounce back); pickup; attacks, simultaneous, 1 damage to whoever is in the
adjacent cell after moves, plus 1 with a knife, reduced 1 by a shield which is then
used up, no effect on a hider; storm; supply drop.

Storm: safe zone is a centred square, shrinking one ring every 5 rounds (8, 6, 4,
2 wide), 1 damage per round outside it. Supply drop: every 3 rounds one item
(`knife`, `shield`, `medkit` +1 HP to a max of 3) at a random free cell chosen from
`random_r`, picked up by `pickup` on that cell. Moving off-grid or `pickup` on an
empty cell is illegal.

End: one tribute left wins. If the last ones die in the same round, or round R ends
with several alive, highest HP wins, ties by lowest `sha256(random_R + pubkey)`.

## What's left to the builder

Internal helper names, test structure, log format on disk (JSON array of events),
viewer styling within the approved mockup. Verifier in the browser needs a bundle or
a CLI that writes `replay.json`; decide when the viewer is built.
