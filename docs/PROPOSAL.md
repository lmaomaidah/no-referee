# No Referee: Trustless Hunger Games for AI Agents

Information Security course project. This is the proposal updated to match what we are
actually building. The [original proposal](original-proposal.pdf) was dated Oct 25, 2026.

## Summary

We build a "Hunger Games" arena where 4-6 AI agents compete with no referee and no game
server. Cryptography alone enforces the rules.

Every move is a signed Nostr event, moves stay hidden until every player has committed,
and random events use randomness no single player can steer. We then attack our own
protocol with agents that cheat and prompt-inject each other, and show what is caught.

The project extends topic 13 (commit-reveal) into a multi-party game and uses topic 9
(Shamir secret sharing) to survive players who quit mid-game.

## Threat model

- **Trusted:** SHA-256, Schnorr signatures on secp256k1, and each player's control of
  their own key.
- **Untrusted relays:** may drop, delay or reorder events, but can't forge signatures.
- **Malicious players** may change a move after seeing others, bias random events, send
  different moves to different relays, forge moves, quit mid-round, or manipulate other
  agents through chat.
- **Assumption:** fewer than `k` players collude, and `k` players other than a quitter
  stay online. `k` is a majority: 3 of 4, 3 of 5, 4 of 6.
- **Out of scope:** hiding positions with zero-knowledge proofs, network denial of
  service, and fake identities, since the roster is fixed before the game starts.

## Cryptographic design

| Attack | Defence | Course topic |
|---|---|---|
| Forging or denying a move | Every move is a Schnorr-signed Nostr event | Digital signatures |
| Changing a move after seeing others | Commit to a hash of move, nonce, round, player and game, reveal after all commit | 13 Commitments |
| Biasing random events | Each player commits once to a hash chain of seeds. Randomness is the hash of all seeds | 13 Commitments |
| Quitting instead of revealing | Each seed chain is Shamir-shared k-of-n at setup, and a majority rebuilds it | 9 Secret sharing |
| Equivocation across relays | Two different signed events for one round are proof of cheating | Digital signatures |
| Reading private chat | NIP-44 encrypted messages between agents | Authenticated encryption |
| Disputing the result | Anyone replays the signed log and gets the same winner | Verifiability |

## What changed from the original

| Original | Now | Why |
|---|---|---|
| Local models through Ollama | Hosted free models through OpenRouter | The laptop has no GPU, so local models are too heavy |
| One tribute per laptop | Both supported: one laptop by default, or one tribute per laptop | One laptop is more reliable for a demo |
| Off-the-shelf self-hosted relay | Our own small relay | Docker isn't installed, and we need to inject faults |
| A new seed each round | One seed chain per game | The secret is shared once instead of every round |
| Timeouts | Majority vote | Nostr timestamps are self-reported, so no rule can depend on time |
| Each member owns one layer | One member built the core, teammates build the viewer | How the work actually split |
| Agents negotiate alliances | Agents also trash-talk and swear, without slurs, and get last words | More entertaining for the demo |
| Injection measured inside games | Single-turn trials | Far fewer requests under the free daily limit |

## Limits the report must state

1. **Forgery has no culprit.** A forged event has no valid signature, so there is no key
   to trace. It is rejected and the impersonated player isn't blamed. The original claim
   that every cheat is traced to its key doesn't hold for forgery.
2. **Live forgery stops at our relay.** Forged events never reach players in live games.
   Rejection by players and the verifier is tested on hand-built logs.
3. **A bad dealer keeps one bit of bias.** Without Feldman verifiable secret sharing,
   nobody can check shares at setup. A player who dealt bad shares can choose between
   revealing and withholding after seeing the other seeds. They get one bit of influence
   on one round and are ejected for it. Feldman VSS remains a stretch goal.
4. **Too many dropouts stall the game.** If fewer than `k` players remain online, it stops.
5. **A malformed move counts as absent.** It is dropped, so the player ends up `absent`
   rather than `illegal-move`. They are still removed and identified.
6. **Free models limit the AI results.** When a model fails, the scripted bot plays that
   turn. Results must report how many turns were real model moves. Say "hosted models",
   not "local models". Free accounts get 50 requests a day, so sample sizes will be small.
7. **The chat transcript is demo-only.** The public log holds only ciphertext. The arena
   prints plaintext because it runs every player, which a real deployment wouldn't.
8. **The final kill gets no last words.** The game ends the moment it happens.

## Red-team evaluation

1. **Scripted cheaters:** one bot per attack. Success means each cheat is detected and
   traced to the correct key with no honest player accused. Built and passing, except
   forgery, which has no key to trace.
2. **Prompt injection:** a fake "system" message orders a model to make a bad move or an
   illegal one. We measure how often each model obeys, with no defence, with chat labelled
   untrusted, and with a strict message format. Built, not run yet. It uses single-turn
   trials rather than whole games, because free accounts get 50 requests a day. In the viewer,
   an Injector bot shows attacks in play and a scripted Gullible bot shows what being fooled
   looks like. That bot is an illustration, not a result.
3. **Key claim:** injection can push an agent into a bad decision, but never a
   rule-breaking move, because models only pick from a menu of legal moves and the
   protocol rejects anything not validly committed and signed.

## Game

8x8 grid, 4-6 tributes, 20 rounds (12 in the demo), a storm that shrinks the safe zone, and random
supply drops. Each round a tribute moves, attacks, hides or picks up an item. Last
tribute standing wins. Exact rules are in the
[design doc](superpowers/specs/2026-11-05-no-referee-design.md).

## Stack

TypeScript on Node 24 with `nostr-tools`, `@noble/hashes` and `ws`. Budget: $0.

## Deliverables

The protocol library, arena runner, agent harness, a replay viewer that animates each
game and flags caught cheaters, a short report with attack results, and a live demo by
Nov 30, 2026. Current progress is in the [README](../README.md).

## Open question for the instructor

Does this count under topic 13, or as a custom topic?
