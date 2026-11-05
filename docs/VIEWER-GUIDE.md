# Replay viewer guide

The viewer is a web page that plays back a finished game. It's plain front-end
work and you don't need to understand the cryptography. The engine writes a JSON
file, and your page draws it.

## Get running

You need Node 24 or newer and git.

```bash
git clone https://github.com/lmaomaidah/no-referee.git
cd no-referee
npx serve viewer
```

Build in `viewer/`, starting with `viewer/index.html`. Use any stack you like, as
long as `viewer/` can be opened with a static file server. Plain HTML, CSS and JS
is enough. Load `sample-replay.json` with `fetch()` until real games exist. It's
hand-written fake data in the exact real format.

## The data

```ts
{
  status: 'finished' | 'stalled',    // stalled: too many players went offline
  winner: string | null,             // player key
  names: { [key]: string },          // display names
  rejected: number,                  // forged or outsider events thrown away
  cheats: [{
    pubkey: string,                  // who was caught
    round: number,
    type: 'equivocation' | 'bad-reveal' | 'illegal-move' | 'state-fork' | 'absent',
    evidence: string[]               // ids of the signed events that prove it
  }],
  rounds: [{
    round: number,                   // 0 is the spawn round
    random: string,                  // that round's shared random value
    moves: { [key]: Move | null },   // null: the move was thrown out
    state: {                         // the board AFTER the round
      round: number,
      safe: number,                  // safe zone width: 8, 6, 4 or 2
      drops: [{ x, y, item }],       // knife, shield or medkit
      players: { [key]: { x, y, hp, item, alive, hiding } }
    }
  }]
}
```

- `Move` is `{a:'move',dir}`, `{a:'attack',dir}`, `{a:'hide'}` or `{a:'pickup'}`,
  and `dir` is `N`, `E`, `S` or `W`.
- The board is 8x8. `x` and `y` run 0 to 7, with 0,0 at the top left. `N` means up.
- The safe zone is a centred square `safe` cells wide. For width `w`, a cell is
  safe when `x` and `y` are both from `(8-w)/2` to `(8-w)/2 + w - 1`.

Real keys are 64 hex characters, so show `names` and shorten keys like `7f3a…c21e`.
The format is a contract with the engine. If you need a field added, ask first
rather than changing the sample.

## What the page must show

1. The 8x8 board with the storm, supply drops and each tribute.
2. Each tribute's name, HP, item, and whether they are alive, out or caught.
3. Play, pause, step, and a timeline to jump to any round. Mark the rounds with cheats.
4. For each cheat: who, which round, the type in plain words, and the evidence ids.
5. The winner, or a clear "game stalled" message.
6. `rejected`: how many forged events were thrown away.

This list is the requirement, and the look is yours. The audience should spot a
caught cheater from across the room. Keep it usable by keyboard and on a projector.

Plain words for the cheat types:

| Type | Say |
|---|---|
| `equivocation` | Signed two different moves for the same round |
| `bad-reveal` | Revealed a move that doesn't match what they locked in |
| `illegal-move` | Locked in a move the rules don't allow |
| `state-fork` | Claimed a different game state from everyone else |
| `absent` | Went silent, and the other players removed them |

`absent` is a dropout rather than proven cheating, so show it in a softer style.

## Sending your work

Work on a branch and open a pull request. Don't commit API keys or `.env`.
