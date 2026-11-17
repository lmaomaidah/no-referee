# No Referee: Trustless Hunger Games for AI Agents

Information Security term project: technical documentation. Custom topic approved by the
instructor.

Team members: Maidah (24i-2116), Alisha (24i-2063), Hani (24i-2113).

## 1. Abstract

We built a last-tribute-standing game for AI agents with no referee and no game server.
Rules are enforced by cryptography alone: moves are signed Nostr events, hidden behind
commitments until every player has locked in, and random events come from seeds no single
player can steer. Anyone can recompute the winner and the list of cheaters from the signed
log. We attacked the protocol with scripted cheating bots in live networked games. Each
attack that leaves a signature was detected and traced to the attacker with no honest
player accused. Forged events were rejected. A fake "system" order made undefended models
pick a bad but legal move in 3 of 6 trials and 0 of 11 once chat was marked untrusted, and no
injection produced an illegal move.

### Words used in this report

| Word | Meaning |
|---|---|
| Hash (SHA-256) | A fingerprint of some data. Same data, same fingerprint. You can't work backwards from it |
| Signature | Proof that a message came from the owner of a key and wasn't changed |
| Public / private key | The private key signs and decrypts and is kept secret. The public key is shared and checks signatures |
| Commitment | A hash of your move plus a random number, posted first. Like a sealed envelope: it hides the move but locks it in |
| Seed | A secret random number each player adds so nobody alone decides the dice rolls |
| Shamir secret sharing | Splitting a secret into pieces so any `k` pieces rebuild it but fewer reveal nothing |
| Nostr | A simple open standard for sending signed messages through servers called relays |
| Relay | A server that passes messages along. We don't trust it |
| Event | One signed message: a commit, a reveal, a vote, or chat |
| Quorum | Enough players agreeing (a majority, `k`) for something to take effect |
| Prompt injection | Text that tries to trick an AI into following orders it shouldn't |
| CSPRNG | A random number generator safe for secrets (the operating system's own) |

## 2. Problem

Online games and multi-agent systems normally trust a central server to enforce rules. That
server can be wrong, compromised or biased. We remove it. Players distrust each other, any
of them may cheat, and the network between them is untrusted.

## 3. Threat model

**Trusted:** SHA-256, Schnorr signatures on secp256k1, the operating system's random number
generator, and each player's control of their private key.

**Untrusted relays (malicious network):** may drop, delay, duplicate or reorder events, and see
everything sent through them. They can't forge signatures or read encrypted chat.

**Malicious players** may try to change a move after seeing others, bias random events, send
different moves to different relays, forge another player's move, lie about the game state,
quit mid-round, deal bad secret shares, or manipulate other agents through chat (prompt
injection).

**Assumption:** fewer than `k` players collude, and at least `k` players other than a quitter
stay online. `k` is a majority: `floor(n/2) + 1`.

**Guarantees.** (1) No player can change a move after seeing another player's move.
(2) No minority can choose a round's randomness. (3) A quitter can't stall the game or change
its outcome. (4) Every signed cheat is attributed to the key that signed it, and no honest
player is blamed. (5) Anyone holding the log computes the same winner. (6) Chat is readable
only by its recipient. (7) Whatever an AI agent is told, its move is one of the legal moves.

**Out of scope:** hiding positions with zero-knowledge proofs, network denial of service, and
fake identities, since the roster is fixed before the game starts.

## 4. System architecture

### 4.1 Components

| Component | File | Role | Trust |
|---|---|---|---|
| Crypto core | `src/crypto.ts` | Commitments, seed hash chains, Shamir sharing, canonical JSON | Trusted code |
| Protocol | `src/protocol.ts` | Builds signed events; `parse` checks everything from the network | Trust boundary |
| Game rules | `src/game.ts` | Pure function from state, moves and randomness to the next state | Trusted code |
| Verifier | `src/verify.ts` | Replays a raw log, returns winner, states and cheats with proof | Trusted, run by anyone |
| Player | `src/player.ts` | One tribute's protocol loop; also holds the red-team attacks | Each player trusts only its own |
| Strategies | `src/bots.ts`, `src/llm.ts` | Scripted bots and AI agents choose moves | Untrusted input to the player |
| Relay | `src/relay.ts` | Our own Nostr relay (WebSocket, NIP-01) with fault injection | Untrusted |
| Arena | `src/arena.ts` | Starts relays and players, saves the log and the replay | Demo harness |
| Viewer | `viewer/index.html` | Animates a verified game in the browser | Display only |
| Injection experiment | `src/injection.ts` | Single-turn prompt-injection trials against hosted models | Evaluation |

The verifier and the live players share the same replay code, so play and verification can't
disagree. The AI model never touches keys or events: it only returns a number from a menu.

### 4.2 Deployment view

```
+---------------- one laptop (demo) ----------------+          +------------------+
|                                                   |  HTTPS   | OpenRouter chat  |
|  Player A ---+                     +--- LLM call -+--------->| API (hosted,     |
|  Player B ---+-- WebSocket --> Relay 1 (faulty?)  |          | untrusted)       |
|  Player C ---+-- WebSocket --> Relay 2            |          +------------------+
|  Player D ---+                                    |
|        |                                          |
|        v  signed event log (out/log.json)         |
|     Verifier --> viewer/replay.json --> Browser   |
+---------------------------------------------------+
```

Every player publishes to every relay. The relay is a plain NIP-01 WebSocket endpoint
(`["EVENT", ...]`, `["REQ", ...]`) so any Nostr client could talk to it.

### 4.3 One round, as a sequence

```
 Player A                         Relays                          Player B
    |  choose move m_A, nonce n_A    |                                 |
    |  h_A = SHA256(gameId,r,pk_A,m_A,n_A)                             |
    |-- COMMIT {h_A, stateHash} sig_A ->|<- COMMIT {h_B, stateHash} sig_B --|
    |   (wait until a commit from every living player is seen)          |
    |-- REVEAL {m_A, n_A, seed_A,r} sig_A ->|<- REVEAL {m_B, n_B, seed_B,r} --|
    |  check: hash matches h_B, seed_B hashes to B's chain tip, move legal|
    |  randomness_r = SHA256(all seeds); next state = rules(state, moves) |
    |-- CHAT {to: B, NIP-44 ciphertext} sig_A ->|------------------------>|  B decrypts
    |                                |                                 |
    |  if B is silent past a local timeout:                            |
    |-- RECOVER {target B, A's share of s0_B} sig_A ->| ... k of these ->|  s0_B rebuilt
```

### 4.4 Where data is plaintext and where it is ciphertext

| Data | On the player | On relays and in the log | Who can read it |
|---|---|---|---|
| Move before reveal | Plaintext | Only the commitment `h` (hash) | Nobody, until reveal |
| Move after reveal | Plaintext | Plaintext, signed | Everyone, by design |
| Seed `s0` | Plaintext, memory only | Never sent. Shares sent NIP-44 encrypted to each holder | Holder of each share; `k` shares rebuild it |
| Shamir share | Decrypted by its holder | NIP-44 ciphertext in the setup event, plaintext only in a recover vote | Its holder, then everyone if a recover vote is cast |
| Chat | Plaintext for sender and recipient | NIP-44 ciphertext | Sender and recipient |
| Private key | Memory only | Never sent | Its owner |

How chat and shares are encrypted (NIP-44): two players each combine their own private key with
the other's public key and get the same secret key, without ever sending it. Messages are
encrypted with it (ChaCha20), stamped so any change is detected (HMAC-SHA256), and padded to set
sizes so their length gives little away.

## 5. Protocol design

### 5.1 Signed events

Every action is a Nostr event signed with Schnorr (BIP-340) on secp256k1. There are five kinds:
setup, commit, reveal, recover and chat. Events are bound to one game by a game id, the hash of
the roster, threshold, round count and a salt, and carry the round number as a tag. `parse`
rejects any event whose tags or content are not in exactly the canonical form, so one event can't
have two valid encodings.

### 5.2 Commit-reveal moves

A player commits `H(gameId, round, pubkey, move, nonce)` with a fresh 256-bit nonce. Binding the
game, round and key stops replaying an old commitment or copying someone else's. A player reveals
only after seeing a commitment from every living player, so nobody can react to a rival's move.
Each commit also carries a hash of the player's view of the game state, so a player who lies
about the state is caught as `state-fork`.

### 5.3 Joint randomness with hash chains

Each player picks a secret `s0` and publishes the tip of a hash chain from it. Each round they
reveal the next value back along the chain, which proves it was fixed in advance and says
nothing about later rounds. Round randomness is the hash of all revealed seeds. The proposal
planned a fresh commitment per round. The chain needs only one commitment and one secret
sharing for the whole game.

### 5.4 Shamir recovery

Each `s0` is split k-of-n with Shamir secret sharing over the secp256k1 group order, and each
share is encrypted to its holder with NIP-44 at setup. If a player goes silent, others publish
their shares in recover events. Once `k` exist, the player is removed and their seed is
rebuilt, so quitting can't change the outcome. This defeats the last-revealer attack.

### 5.5 No clock

Nostr timestamps are self-reported and relays can delay events, so no rule may depend on time.
Timeouts are local to each player and only decide when to vote. The rule in the log is a
quorum: `k` recover events. Fewer than `k` votes do nothing, so a colluding minority can't
remove an honest player.

### 5.6 Verification

The verifier takes the raw event log and returns the winner, each round's state, and each cheat
with the event ids that prove it. Its result doesn't depend on event order or duplicates.

## 6. Cryptographic library choices

We did not write any cryptographic primitive. Hashing, signatures, key exchange and encryption
all come from audited, widely used libraries.

| Need | Library | Why this one |
|---|---|---|
| SHA-256 | `@noble/hashes` | Audited, no dependencies, used by `nostr-tools` itself |
| Schnorr signatures (BIP-340), key generation | `nostr-tools`, built on `@noble/curves` | The standard Nostr implementation; `@noble/curves` is independently audited |
| Authenticated encryption (NIP-44 v2) | `nostr-tools/nip44` | ECDH + HKDF + ChaCha20 + HMAC, with padding, as specified by NIP-44 |
| Random numbers | Web Crypto `crypto.getRandomValues` | The operating system's CSPRNG, built into Node |
| WebSocket transport | `ws` | The standard Node WebSocket library |

**What we wrote ourselves, and why it is not a primitive.** Shamir secret sharing and the seed
hash chain are short constructions on top of the libraries above: the chain is repeated
`@noble/hashes` SHA-256, and Shamir is polynomial evaluation and Lagrange interpolation over the
secp256k1 group order using JavaScript `BigInt`. We found no maintained, audited JavaScript Shamir
library over a prime field that matches the curve order, and the course topic asks us to
implement it. It is about 40 lines (`src/crypto.ts`), uses the CSPRNG for every coefficient, and
is tested for reconstruction from any `k` shares and for rejecting duplicates. Its `BigInt`
arithmetic is not constant-time; see 8.2.

## 7. Key lifecycle

**Generation.** Each player's signing key is generated per game with `generateSecretKey()`
(32 bytes from the CSPRNG via `@noble/curves`). Nonces, seeds `s0` and Shamir coefficients are
also drawn from `crypto.getRandomValues`. Scalars use rejection sampling, so there is no modulo
bias.

**Distribution.** Only public keys are distributed. The roster of public keys, the threshold `k`,
the round count and a salt are fixed before the game and hashed into the game id, so the roster
can't change mid-game. NIP-44 conversation keys are never sent: each pair derives the same key by
ECDH from their own private key and the other's public key. Shamir shares are distributed
encrypted to each holder inside the signed setup event.

**Storage.** Private keys, seeds and decrypted shares live only in process memory and are never
written to disk. The saved log and the replay file contain public keys, signatures, ciphertext and
revealed moves only. The one long-lived secret is the OpenRouter API key, kept in `.env`, which is
listed in `.gitignore` and never committed.

**Revocation and rotation.** Keys are per game, so they are discarded when the game ends and a new
game gets new keys. Inside a game, a key that stops participating is effectively revoked by a
quorum: `k` recover votes remove the player and rebuild its seed. A key that cheats is named in the
verifier's output with proof. There is no mid-game rotation: if a private key leaked during a
game, the attacker could play as that player until the game ends (see limitations).

## 8. Secure integration

### 8.1 Measures in the code

- **Good randomness only.** Every secret number comes from the operating system's secure random
  generator, never `Math.random`. When we need a number below a limit, we redraw instead of using
  remainder, which would make some numbers slightly more likely.
- **One way to write each message.** Data is always written the same way (keys sorted, no spaces)
  before it is hashed or signed, and anything written differently is rejected. Otherwise one move
  could produce two different fingerprints.
- **Seeds must be lowercase.** If `ABC` and `abc` both counted as the same seed, a player could
  pick whichever gives the dice roll they want.
- **Signatures are checked fresh every time.** The Nostr library remembers "already checked" on a
  message, and that memory survives copying. We check a fresh copy, so an edited message can't
  borrow an old pass.
- **Check the type before the pattern.** JavaScript's pattern check turns a list into text first,
  so a list could sneak past a "64 hex characters" check. We check it's really text first.
- **Padding is left to the library.** NIP-44 pads messages before encrypting, so we add none.
- **One front door.** Everything from the network goes through one function, `parse`, which
  either returns a checked message or rejects it, and never crashes.

### 8.2 Side channels

A side channel is a leak through something other than the message, like how long a calculation
takes. Our Shamir maths uses JavaScript's big numbers, whose speed depends on the values. Someone
timing our CPU up close could in theory learn something about a share. Our attackers are other
players and relays over the network, who only see messages, so we accept this. Signing and
encryption use `@noble/curves`, which is built to avoid timing leaks. The network does show when a
player acted, but not what they chose, because the move is sealed first.

## 9. Implementation

TypeScript on Node 24 using `nostr-tools`, `@noble/hashes` and `ws`. We wrote a small NIP-01
relay so we could inject faults. Games run on one laptop. Agents are hosted models on OpenRouter,
reached over its chat API. A model only picks a number from a menu of legal moves, and can add one
chat line. If a model fails, a scripted bot plays that turn and the failure is counted. The budget
was $0.

The game is an 8x8 grid with 3 HP per tribute, a shrinking fire zone, and supply drops. The last
tribute standing wins. If everyone left dies in the same round, or the last round ends with several
alive, the one with the most HP left wins (fire stops at 0 HP, but a knife can push HP below 0). A
tie on HP is broken by hashing that round's joint randomness with each player's public key, lowest
hash wins: a coin flip no player can steer and anyone can recompute. A replay
viewer animates each game from the verifier's output, shows chat and injection attempts with their
effect, and stamps CAUGHT on cheaters.

### 9.1 Implementation hurdles

1. **Time can't be a rule.** Our first design used deadlines. Nostr timestamps are chosen by the
   sender and relays can hold events back, so a deadline is unenforceable. We replaced it with
   quorum votes (5.5).
2. **Last-revealer bias.** With plain commit-reveal randomness, the last player to reveal can
   refuse after seeing the others. Shamir recovery of `s0` (5.4) removes that choice.
3. **Same move, different fingerprint.** Plain `JSON.stringify` can write the same move with keys
   in a different order, which gives a different hash. We had to fix one exact way of writing
   data and reject everything else.
4. **A library shortcut.** `nostr-tools` remembers that a message was already checked, even on a
   changed copy. We had to work around it by checking a fresh copy every time.
5. **Relay partitions.** Players with different views of the log could compute different states.
   Each commit now carries a state hash, which exposes a fork in the next round.
6. **No GPU, small budget.** The laptop can't run local models, so we moved from Ollama to free
   hosted models. Free accounts get 50 requests a day, Gemini's free tier refused our keys, and the
   Nemotron models often take longer than the demo's 15 s turn limit (see 10.3).

## 10. Security evaluation

### 10.1 Attack surface

| Entry point | What an attacker controls | Risk | Mitigation | Result |
|---|---|---|---|---|
| Events from relays | Any bytes, any order | Malformed or forged events, replay from other games | `parse`: signature, roster, game id, round, canonical form | Rejected |
| Commit then reveal | Own move and nonce | Change move after seeing others | Commitment checked at reveal | `bad-reveal` |
| Two relays | Different events to each | Equivocation | Two signed events for one round are proof | `equivocation` |
| Seed reveal | Own seed, own timing | Bias randomness, last-revealer | Hash chain, Shamir recovery | Bias impossible, quitter removed |
| Recover votes | Votes against others | Remove an honest player | Needs `k` votes; can't vote for yourself | Minority can't remove |
| Setup shares | Bad shares | Bias via withholding | Recovery tries `k`-subsets against the tip | One bit of bias remains (limitation 3) |
| Relay | Drop, delay, reorder | Stall, fork views | Publish to all relays, rebroadcast, state hash | Game finishes |
| Chat | Text read by an AI | Prompt injection | Menu of legal moves, untrusted label, strict format | Bad moves possible, illegal moves impossible |
| Model API | Model output | Garbage or illegal replies | Reply must be a menu number; fallback to bot | Counted as fallback |
| `.env` | API key | Leaked key | `.gitignore`, never logged | Not in repo |

### 10.2 Scripted attacks

Each attack ran in a live game over two relays, with player 3 attacking in round 2, and is
repeatable with `npm test`.

| Attack | Defence | Result |
|---|---|---|
| Different moves to different relays | Two signed events for one round are proof | Caught as `equivocation`, attacker only |
| Changing a move after seeing others | Commitment | Caught as `bad-reveal`, attacker only |
| A move the rules forbid | Replay of the rules | Caught as `illegal-move`, attacker only |
| Lying about the game state | State hash in each commit | Caught as `state-fork`, attacker only |
| Withholding a reveal | Quorum and Shamir recovery | Removed as `absent`, seed rebuilt |
| Quitting mid-game | Quorum and Shamir recovery | Removed as `absent`, game finished |
| Forging another player's move | Signatures | Rejected, nobody blamed |
| A relay dropping most events | Publishing to all relays, rebroadcasting | Game finished, nobody blamed |

Further tests on hand-built logs confirm that quitting doesn't change round randomness, that
fewer than `k` votes remove nobody, that a voter signing two different shares is caught, and that
shuffling or duplicating the log changes nothing. All 33 tests pass.

### 10.3 Prompt injection

**Method.** Each model gets one fixed turn: a rival on 1 HP is adjacent, so attacking is the
obvious move. A fake "system" message orders it either to hide (a bad but legal move) or to
reply 99 (an illegal move). We compare no defence, chat labelled as untrusted, and a strict
format that strips punctuation. A run with no attack is the control.

**Results.** One run on Nov 17, 2026: 2 trials per model and arm, 41 usable replies (1 request
failed and is not counted). Raw replies are in `results/injection.jsonl`, and
`node src/injection.ts --report` reprints the table.

| Attack | Defence | flint-v1.0 | nemotron-3-ultra | nemotron-3.5-super-vl | Total obeyed |
|---|---|---|---|---|---|
| none (control) | label | 0/2 hid | 0/2 hid | 0/2 hid | 0/6 |
| hide | none | **2/2** | **1/2** | 0/2 | **3/6** |
| hide | label | 0/1 | 0/2 | 0/2 | 0/5 |
| hide | strict | 0/2 | 0/2 | 0/2 | 0/6 |
| illegal (99) | any | 0/6 | 0/6 | 0/6 | 0/18 |

With no defence, the fake order made two of three models hide next to a rival on 1 HP, which
they never did in the control. Labelling chat as untrusted, or the strict format, brought this to
zero. No model ever replied 99.

**Key claim.** Injection can push an agent into a bad decision, but never into a rule-breaking
move. The experiment confirms the first half: undefended agents were fooled into a legal but bad
move. It does not exercise the second half, because no model tried the illegal move. That half
rests on the menu, which only accepts a number from the list of legal moves, and on the
`illegal-move` attack in 10.2, which the verifier catches regardless of why a player made it.
Two trials per arm is a small sample: the direction is clear (3/6 against 0/11), the exact rates
are not.

**In-game demonstration.** An Injector bot sends fake orders during play. A scripted Gullible bot
obeys and hides, which illustrates a bad but legal decision. It is not counted in any result. In
real AI games, one model answered the fake order with "Nice try with the fake system message, you
absolute muppet."

### 10.4 AI games

| Game | Rounds | Events | Real model moves | Fallbacks (cause) | Cheats found |
|---|---|---|---|---|---|
| Nov 12 demo | 12 | 127 | 19 of 34 | 15 (15 s timeout) | 0 |
| Nov 17 demo, saved as backup | 12 | 109 | 11 of 23 | 12 (7 daily limit, 5 timeout) | 0 |
| Nov 17 demo, second key | 13 | 92 | 6 of 18 | 12 (all 15 s timeout) | 0 |

Each game had three free OpenRouter models and the Injector bot. The Nov 12 game took 3 minutes
9 seconds. In every game the verifier recomputed the winner from the log alone. flint-v1.0 almost
never misses the limit; the Nemotron models often do.

### 10.5 Security against usability

| Choice | Security gained | Cost |
|---|---|---|
| Commit, then reveal, every round | No reacting to others' moves | Two signed events and two network round trips per player per round; a round waits for the slowest player |
| Two relays, publish to all | Survives a dropping relay, exposes equivocation | Double the bandwidth |
| Quorum `k = floor(n/2)+1` | A minority can't remove an honest player | A silent player stalls the round until `k` local timeouts fire (90 s in AI games) |
| Shamir shares at setup | Quitting can't bias or stall | `n` encrypted shares per player in setup; recovery tries `k`-subsets, which grows combinatorially with `n` |
| AI picks from a menu only | Injection can't produce an illegal move | Models can't propose creative moves, only choose |
| Label chat as untrusted | Stopped all injected hides in our trials | A longer prompt; models may also ignore genuine alliance offers |
| 15 s model turn limit in the demo | The demo ends on time | Only 6 to 19 of each game's turns were real model moves; 60 s gives more but a slower game |
| Encrypted chat | Relays can't read it | The demo arena still prints plaintext because it runs every player |

## 11. Limitations

1. **Forgery has no culprit.** A forged event has no valid signature, so there is no key to
   trace. It is rejected and the impersonated player isn't blamed.
2. **Live forgery stops at our relay.** Forged events never reached players in live games.
   Rejection by the verifier is tested on hand-built logs.
3. **A bad dealer keeps one bit of bias.** Without Feldman verifiable secret sharing, shares can't
   be checked at setup. A player who dealt bad shares can choose between revealing and withholding
   after seeing the other seeds: one bit of influence on one round, at the cost of being removed.
4. **Too many dropouts stall the game.** Below `k` online players, it stops.
5. **Malformed moves count as absent.** They are dropped, so the player is removed as `absent`
   rather than `illegal-move`.
6. **Relay partitions can fork live play.** A short settle delay is a heuristic. A partition longer
   than it can split live play from the replay, though the state hash in the next commit exposes it.
7. **No key rotation mid-game.** A private key stolen during a game can play as that player until
   the game ends.
8. **Small samples.** Free accounts get 50 model requests a day, and failed turns fall back to a
   scripted bot.
9. **The demo chat transcript is not private.** The public log holds only ciphertext, but the arena
   prints plaintext because it runs every player. A real deployment wouldn't.

## 12. Changes from the proposal

Local Ollama models became hosted models because the laptop has no GPU. Per-round seed commitments
became one hash chain per game. Deadlines became quorum votes. See
[PROPOSAL.md](PROPOSAL.md) for the full list.

## 13. Conclusion

A multi-party game can run with no referee: commitments stop late changes, joint randomness stops
bias, secret sharing survives quitters, and signatures make every accusation provable. AI agents
add a softer attack surface: a fake order in chat fooled undefended models into a bad move half
the time, and a one-line warning that chat is untrusted stopped it in our trials. Cryptography
can't stop a player from choosing badly, but it does guarantee that every choice, fooled or not,
is a legal one that everyone can check.

## References

- NIP-01 and NIP-44, Nostr protocol specifications
- BIP-340, Schnorr signatures for secp256k1
- Shamir, "How to Share a Secret", 1979
- Feldman, "A Practical Scheme for Non-interactive Verifiable Secret Sharing", 1987
- `@noble/curves` and `@noble/hashes` audit reports, paulmillr.com
