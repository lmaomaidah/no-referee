# Team guide

Everything you need to pick up work on No Referee. The current list of what's done
and what's left is in the [README](../README.md).

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

That runs a full game with scripted bots and writes `viewer/replay.json`.

To run AI players, make your own free key at openrouter.ai and create a file called
`.env` in the project folder:

```
OPENROUTER_API_KEY=your-key-here
```

Then run `node src/arena.ts --ai 6` for a 6-round game. Expect several minutes on free
models. **Never commit `.env` or paste keys into code, chats or issues.** Git already
ignores `.env`.

## Where things are

| File | What it does |
|---|---|
| `src/crypto.ts` | Hashes, commitments, seed chains, Shamir sharing |
| `src/protocol.ts` | Builds and checks signed events. Anything from the network goes through `parse` |
| `src/game.ts` | The game rules, as pure functions |
| `src/verify.ts` | Replays a log and finds the winner and cheaters |
| `src/player.ts` | One live player. Also holds the red-team attacks |
| `src/bots.ts` | Scripted strategies |
| `src/llm.ts` | AI strategy. The model only picks a number from a menu of legal moves |
| `src/relay.ts` | Our Nostr relay |
| `src/arena.ts` | Runs a whole game |
| `viewer/` | Replay viewer, not built yet |

Useful docs:

- [Viewer guide](VIEWER-GUIDE.md): the UI task, with the data format and requirements
- [Project proposal, updated](PROPOSAL.md): what we are actually building
- [Original proposal](original-proposal.pdf): what we first submitted
- [Design doc](superpowers/specs/2026-11-05-no-referee-design.md): the exact protocol and rules

## Tasks you can pick up

### Replay viewer

The biggest open task, and it needs no cryptography. Follow the
[viewer guide](VIEWER-GUIDE.md). You can start right away with `viewer/sample-replay.json`.

### Agent chat and alliances

The proposal has agents negotiate in private. `buildChat` in `src/protocol.ts` already
makes a signed, encrypted message, but players don't send or read them yet. This needs:

1. A chat step in `src/player.ts` before each commit.
2. Received messages passed into the prompt in `src/llm.ts`, clearly labelled as
   untrusted.
3. A check that chat events still can't affect the verifier's result.

### Prompt-injection experiment

Depends on chat. Attacker agents send messages like fake "system" instructions, and we
measure how often each model obeys, with and without defences such as labelling chat as
untrusted. Keep game counts small because of free limits, and start early, since it may
take several days of quota.

The claim to prove: injection can push an agent into a bad decision, but never a
rule-breaking move. `src/llm.test.ts` already covers the menu side of that.

### Report

Use the attack list below as the results table. Include every limit in the
[updated proposal](PROPOSAL.md), and report how many AI turns were real model moves.

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
