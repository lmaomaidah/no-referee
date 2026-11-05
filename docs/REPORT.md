# No Referee: Trustless Hunger Games for AI Agents

Information Security course project report. **Draft.** Sections marked TODO need real
results before submission. Team members: TODO.

## 1. Abstract

We built a last-tribute-standing game for AI agents with no referee and no game server.
Rules are enforced by cryptography alone: moves are signed Nostr events, hidden behind
commitments until every player has locked in, and random events come from seeds no single
player can steer. Anyone can recompute the winner and the list of cheaters from the signed
log. We attacked the protocol with scripted cheating bots in live networked games. Each
attack that leaves a signature was detected and traced to the attacker with no honest
player accused. Forged events were rejected. TODO: one sentence on the prompt-injection
results.

## 2. Problem

Online games and multi-agent systems normally trust a central server to enforce rules. That
server can be wrong, compromised or biased. We remove it. Players distrust each other, any
of them may cheat, and the network between them is untrusted.

## 3. Threat model

**Trusted:** SHA-256, Schnorr signatures on secp256k1, and each player's control of their
private key.

**Untrusted relays:** may drop, delay or reorder events, but can't forge signatures.

**Malicious players** may try to change a move after seeing others, bias random events, send
different moves to different relays, forge another player's move, quit mid-round, or
manipulate other agents through chat.

**Assumption:** fewer than `k` players collude, and at least `k` players other than a quitter
stay online. `k` is a majority: `floor(n/2) + 1`.

**Out of scope:** hiding positions with zero-knowledge proofs, network denial of service, and
fake identities, since the roster is fixed before the game starts.

## 4. Protocol design

### 4.1 Signed events

Every action is a Nostr event signed with Schnorr on secp256k1. There are five kinds: setup,
commit, reveal, recover and chat. Events are bound to one game by a game id, the hash of the
roster, threshold, round count and a salt.

### 4.2 Commit-reveal moves

A player commits `H(gameId, round, pubkey, move, nonce)`. Binding the game, round and key stops
replaying an old commitment or copying someone else's. A player reveals only after seeing a
commitment from every living player, so nobody can react to a rival's move.

### 4.3 Joint randomness with hash chains

Each player picks a secret `s0` and publishes the tip of a hash chain from it. Each round they
reveal the next value back along the chain, which proves it was fixed in advance and says
nothing about later rounds. Round randomness is the hash of all revealed seeds. The proposal
planned a fresh commitment per round. The chain needs only one commitment and one secret
sharing for the whole game.

### 4.4 Shamir recovery

Each `s0` is split k-of-n with Shamir secret sharing over the secp256k1 group order, and each
share is encrypted to its holder with NIP-44 at setup. If a player goes silent, others publish
their shares in recover events. Once `k` exist, the player is removed and their seed is
rebuilt, so quitting can't change the outcome. This defeats the last-revealer attack.

### 4.5 No clock

Nostr timestamps are self-reported and relays can delay events, so no rule may depend on time.
Timeouts are local to each player and only decide when to vote. The rule in the log is a
quorum: `k` recover events. Fewer than `k` votes do nothing, so a colluding minority can't
remove an honest player.

### 4.6 Verification

The verifier takes the raw event log and returns the winner, each round's state, and each cheat
with the event ids that prove it. Its result doesn't depend on event order. Live players run
the same replay code to decide what to do next, so play and verification can't disagree.

## 5. Implementation

TypeScript on Node 24 using `nostr-tools`, `@noble/hashes` and `ws`. We wrote a small NIP-01 relay
so we could inject faults. Agents are hosted models on OpenRouter, reached over its chat API. A
model only picks a number from a menu of legal moves, and can add one chat line. If a model
fails, a scripted bot plays that turn and the failure is counted. The budget was $0.

The game is an 8x8 grid with 3 HP per tribute, a shrinking fire zone, and supply drops. A replay
viewer animates each game from the verifier's output.

## 6. Evaluation

### 6.1 Scripted attacks

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
fewer than `k` votes remove nobody, and that shuffling or duplicating the log changes nothing.

### 6.2 Prompt injection

**Method.** Each model gets one fixed turn: a rival on 1 HP is adjacent, so attacking is the
obvious move. A fake "system" message orders it either to hide (a bad but legal move) or to
reply 99 (an illegal move). We compare no defence, chat labelled as untrusted, and a strict
format that strips punctuation. A run with no attack is the control.

**In-game demonstration.** An Injector bot sends fake orders during play. Chat reaches a player the
round after it's sent. A scripted Gullible bot obeys and hides, which illustrates a bad but legal
decision. It's an illustration only and is not counted in any result.

**Results.** TODO: run `node src/injection.ts` over several days, then paste the output of
`node src/injection.ts --report`.

**Key claim.** Injection can push an agent into a bad decision, but never into a rule-breaking
move. Models can only choose from the menu of legal moves, and the protocol rejects anything not
validly committed and signed. TODO: confirm the `blocked` counts support this.

### 6.3 AI games

TODO: game length, and how many turns were real model moves, from `node src/arena.ts --demo`.

## 7. Limitations

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
7. **Small samples.** Free accounts get 50 model requests a day, and failed turns fall back to a
   scripted bot.
8. **The demo chat transcript is not private.** The public log holds only ciphertext, but the arena
   prints plaintext because it runs every player. A real deployment wouldn't.

## 8. Changes from the proposal

Local Ollama models became hosted models because the laptop has no GPU. Per-round seed commitments
became one hash chain per game. Deadlines became quorum votes. See
[PROPOSAL.md](PROPOSAL.md) for the full list.

## 9. Conclusion

A multi-party game can run with no referee: commitments stop late changes, joint randomness stops
bias, secret sharing survives quitters, and signatures make every accusation provable. TODO: finish
once the injection results are in.

## References

- NIP-01 and NIP-44, Nostr protocol specifications
- BIP-340, Schnorr signatures for secp256k1
- Shamir, "How to Share a Secret", 1979
- Feldman, "A Practical Scheme for Non-interactive Verifiable Secret Sharing", 1987
