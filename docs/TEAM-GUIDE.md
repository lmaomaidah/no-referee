# Team guide

Everything you need to pick up work on No Referee. For a plain explanation of the project,
read [EXPLAINED.md](EXPLAINED.md) first. The current list of what's done and what's left is in
the [README](../README.md).

## The idea in one minute

Four to six AI players fight on an 8x8 grid. Normally a game server enforces the
rules. Here there is no server, so a cheater has to be stopped by cryptography alone.

Each round works like this:

1. **Commit.** Every player locks in a move by publishing a hash of it. Nobody can
   read it, and nobody can change it later.
2. **Reveal.** Once everyone has locked in, each player reveals their move plus a
   secret seed. The hash proves the move wasn't changed.
3. **Resolve.** Everyone runs the same rules. The combined seeds decide random events,
   and no single player can steer them.

All of this is signed and published to Nostr relays. Relays are untrusted: they can
lose messages but can't fake them. Anyone can take the log, run the verifier, and get
the same winner and the same list of cheaters.

If a player goes silent, a majority of players publish their pieces of that player's
secret (Shamir sharing). That removes them and rebuilds their seed, so quitting can't
change the outcome.

## Setup

You need Node 24 or newer and git. Ask the repo owner to invite your GitHub account.

```bash
git clone https://github.com/lmaomaidah/no-referee.git
cd no-referee
npm install
node src/arena.ts
```

That runs a full game with scripted bots and writes `viewer/replay.json`. To watch it, run
`npx serve viewer` and open the address it prints. `node src/arena.ts --cheat equivocate` plays
a game with a cheater in it. Other cheats: `change-move`, `illegal`, `lie-state`, `withhold`.

To run AI players, make your own free key at openrouter.ai and create a file called
`.env` in the project folder:

```
OPENROUTER_API_KEY=your-key-here
```

Then run `node src/arena.ts --ai 6` for a 6-round game. Expect several minutes on free
models, and note that each game uses part of your 50 free requests for the day. It prints
the chat, and AI turns that fell back to the scripted bot. **Never commit `.env` or paste keys into code, chats or issues.** Git already
ignores `.env`.

## Where things are

| File | What it does |
|---|---|
| `src/crypto.ts` | Hashes, commitments, seed chains, Shamir sharing |
| `src/protocol.ts` | Builds and checks signed events. Anything from the network goes through `parse` |
| `src/game.ts` | The game rules, as pure functions |
| `src/verify.ts` | Replays a log and finds the winner and cheaters |
| `src/player.ts` | One live player. Also holds the red-team attacks |
| `src/bots.ts` | Scripted players: normal, Injector, Gullible, quitter |
| `src/llm.ts` | AI strategy and trash talk. The model only picks a number from a menu of legal moves |
| `src/models.ts` | The list of free models in use |
| `src/injection.ts` | The prompt-injection experiment |
| `src/relay.ts` | Our Nostr relay. Run it directly to host a multi-laptop game |
| `src/join.ts` | Join a multi-laptop game, see [TWO-LAPTOPS.md](TWO-LAPTOPS.md) |
| `src/arena.ts` | Runs a whole game |
| `viewer/` | Replay viewer: styled and working, open to polish |

Useful docs:

- [Viewer guide](VIEWER-GUIDE.md): the UI task, with the data format and requirements
- [Plain explanation](EXPLAINED.md): the project with no jargon
- [Several laptops](TWO-LAPTOPS.md): how to run a game across machines
- [Report draft](REPORT.md): edit it on GitHub as results come in
- [Project proposal, updated](PROPOSAL.md): what we are actually building
- [Original proposal](original-proposal.pdf): what we first submitted
- [Design doc](superpowers/specs/2026-11-05-no-referee-design.md): the exact protocol and rules

## Tasks you can pick up

### Replay viewer

A styled version works and is open to polish. No cryptography needed. Follow the [viewer guide](VIEWER-GUIDE.md), and use `viewer/sample-replay.json`
to start.

### Prompt-injection experiment

Built in `src/injection.ts`, ready to run. Each model gets one fixed turn where attacking is
the obvious move, and a fake "system" message tells it either to hide (a bad decision) or to
reply 99 (an illegal move). It runs with no defence, with chat labelled untrusted, and with a
strict format that strips punctuation. The no-attack row is the control.

Run `node src/injection.ts`. It stops by itself at the daily limit, keeps what it has, and adds
to `results/injection.jsonl`, so commit that file. `--report` prints the table without using
requests. Two trials per arm (the default) is not enough to claim much, so keep adding trials. Each OpenRouter account gets 50 free requests a day, so spread runs across
teammates' keys and start early.

In-game, the Injector bot sends fake orders and the Gullible bot obeys them, so you can see the
effect. That bot is scripted and proves nothing about real models. Only this experiment does.

The claim to prove: injection can push an agent into a bad decision, but never a
rule-breaking move. `src/llm.test.ts` already covers the menu side of that.

### Report

A draft is in [REPORT.md](REPORT.md), and everyone can edit it on GitHub. Fill the TODO
sections once the model results are in.

## Attacks already covered

Each runs in a live game in `src/arena.test.ts`.

| Attack | Result |
|---|---|
| Different moves to different relays | Caught as `equivocation` |
| Changing a move after seeing others | Caught as `bad-reveal` |
| A move the rules forbid | Caught as `illegal-move` |
| Lying about the game state | Caught as `state-fork` |
| Withholding a reveal | Voted out as `absent`, seed rebuilt |
| Quitting mid-game | Voted out as `absent` |
| Forging another player's move | Rejected, nobody blamed |
| A relay dropping most events | Game still finishes |

## How we work

- Run `git pull` first, then commit and push straight to `main`. No pull requests or
  side branches.
- Only push code that works. Run `npm test` and `npm run check` first if you touched
  `src/`.
- Keep it simple: no new dependencies or abstractions unless they're really needed.
- Only keep tests that prove something important, like an attack being caught. Delete
  throwaway tests once they've done their job.
- When you finish something, update the Status section of the README.
