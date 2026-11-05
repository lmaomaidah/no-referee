# No Referee

A last-tribute-standing game for AI agents with no referee and no game server.
Every move is a signed Nostr event, and anyone can recompute the winner from the
signed log. Information Security course project, due **Nov 30, 2026**.

**New to the project? Start with [docs/TEAM-GUIDE.md](docs/TEAM-GUIDE.md).**

## Run it

You need Node 24 or newer.

```bash
npm install
node src/arena.ts          # one game with scripted bots, under a minute
node src/arena.ts --cheat equivocate   # bot game with a cheater, no requests needed
npx serve viewer           # watch the last game in your browser
node src/arena.ts --demo   # AI game built for the demo: 12 rounds, about 39 of your 50 daily requests
node src/injection.ts      # prompt-injection trials, about 42 requests, needs .env
node src/injection.ts --report   # print the results so far, no requests
npm test                   # attack suite and live games, a few minutes
```

## Status

Last updated Nov 5, 2026.

### Done

- [x] Commitments, seed chains, Shamir recovery, signed events (`src/crypto.ts`, `src/protocol.ts`)
- [x] Game rules (`src/game.ts`)
- [x] Self-written Nostr relay with fault injection (`src/relay.ts`)
- [x] Replay verifier that catches and attributes cheats (`src/verify.ts`)
- [x] Player loop and arena (`src/player.ts`, `src/arena.ts`)
- [x] Live attacks: equivocation, changed move, illegal move, state lie, withheld reveal, forgery, quitting, dropping relay
- [x] AI players on OpenRouter (`src/llm.ts`), limited by free-tier reliability, see below
- [x] Styled replay viewer (`viewer/index.html`): animated fighters, fire storm, speech bubbles, CAUGHT stamp
- [x] Demo mode with a hard time limit per model (`--demo`), timing not yet measured on real models
- [x] Encrypted agent chat, trash talk and last words (tests pass, not yet seen with real models because the daily limit ran out)

### Left

| Task | Owner | Notes |
|---|---|---|
| Polish the replay viewer | Teammates | Styled version works, follow [docs/VIEWER-GUIDE.md](docs/VIEWER-GUIDE.md) |
| Prompt-injection experiment | Open | Built (`src/injection.ts`), not yet run. Results go in `results/injection.jsonl`, commit them |
| Reliable model access | Open | See known problems |
| Report | Open | Must state the limits in [docs/PROPOSAL.md](docs/PROPOSAL.md) |
| Live demo | Everyone | Rehearse with a saved game as backup |
| Ask the instructor: topic 13 or custom? | Open | Still unanswered in the proposal |

### Known problems

- **50 free model requests a day per OpenRouter account.** A 20-round game with three AI
  players needs up to 60, so it won't fit on one key. Each teammate's own key gets its own
  50. OpenRouter offers 1000 a day after adding 10 credits, which is outside the $0 budget.
- **Free models are unreliable.** In a 6-round test game only 4 of 15 AI turns were
  real model moves. The rest hit rate limits, server errors or timeouts and the
  scripted bot played instead. `node src/arena.ts --ai 6` prints these counts.
- **Gemini is not in use.** Both keys tried returned 403: the free tier isn't available
  for those projects and Google asks for billing.
- **One laptop only.** The relay accepts local connections only. Running one tribute
  per laptop needs the relay opened to the network.
