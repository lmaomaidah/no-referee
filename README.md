# No Referee

A Hunger Games-style battle between AI players where **nobody is in charge**: no referee,
no game server. Maths enforces the rules. Players lock in moves in sealed "envelopes", sign
everything they do, and anyone can replay the game to check the winner. We then attack it with
cheating bots and prompt injection, and show the rules hold.

Information Security course project, due **Nov 30, 2026**.

- **What is this? Read [docs/EXPLAINED.md](docs/EXPLAINED.md).** No technical background needed.
- **Joining the team? Read [docs/TEAM-GUIDE.md](docs/TEAM-GUIDE.md).**
- **The write-up:** [docs/REPORT.md](docs/REPORT.md), a draft we keep editing here.

## Run it

You need Node 24 or newer.

```bash
npm install
node src/arena.ts          # one game with scripted bots, under a minute
node src/arena.ts --cheat equivocate   # bot game with a cheater, no requests needed
npx serve viewer           # watch the last game in your browser
# Several laptops? See docs/TWO-LAPTOPS.md
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
- [x] Replay viewer (`viewer/index.html`): painted arena, one action at a time with captions, injection attempts and their effects, CAUGHT stamp
- [x] In-game injection demo: Injector bot, plus a scripted Gullible bot that shows what being fooled looks like
- [x] Report draft ([docs/REPORT.md](docs/REPORT.md)), TODO sections need model results
- [x] Multi-laptop mode (`src/join.ts`), one-laptop mode is still the default
- [x] Demo mode with a hard time limit per model (`--demo`), timing not yet measured on real models
- [x] Encrypted agent chat, trash talk and last words (tests pass, not yet seen with real models because the daily limit ran out)

### Left

| Task | Owner | Notes |
|---|---|---|
| See real AI games and trash talk | Open | Run `node src/arena.ts --demo` after the daily limit resets |
| Try two-laptop mode on real laptops | Everyone | Tested with separate processes only. Follow [docs/TWO-LAPTOPS.md](docs/TWO-LAPTOPS.md) |
| Polish the replay viewer | Teammates | Styled version works, follow [docs/VIEWER-GUIDE.md](docs/VIEWER-GUIDE.md) |
| Prompt-injection experiment | Open | Built (`src/injection.ts`), not yet run. Results go in `results/injection.jsonl`, commit them |
| Reliable model access | Open | See known problems |
| Finish the report | Open | Fill the TODO sections in [docs/REPORT.md](docs/REPORT.md) |
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
- **Scripted bots can't be fooled.** Only the Gullible bot reacts to injection, and that's scripted.
  Real results need real models.
