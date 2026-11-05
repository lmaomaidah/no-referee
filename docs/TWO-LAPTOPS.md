# Playing across several laptops

One-laptop mode still works and stays the default (`node src/arena.ts`). This mode runs each
player on its own laptop, so each player's secrets never leave their machine.

All laptops must be on the same network. A phone hotspot works if the campus Wi-Fi blocks devices
from reaching each other. Every laptop needs the project and `npm install`.

## 1. Host: start the relay

```bash
node src/relay.ts
```

It prints an address like `ws://192.168.1.20:7777`. If Windows asks about the firewall, allow access
on private networks.

The relay is untrusted by design, so it doesn't matter who hosts it, and the host can also play.

## 2. Everyone: make a key

```bash
node src/join.ts key
```

This saves a private key in `.player-key`. Never share or commit that file. Send the host the public
key it prints.

## 3. Host: create the game

Give each player a name, with their public key after the `=`:

```bash
node src/join.ts new ws://192.168.1.20:7777 Ali=<public key> Sara=<public key> Zain=<public key>
```

Send the new `game.json` to everyone. You need at least two players, and four is best. It prints a
game id, which every player should see when they start.

## 4. Everyone: play

As a scripted bot:

```bash
node src/join.ts play game.json
```

As an AI model, which needs your own key in `.env`:

```bash
node src/join.ts play game.json .player-key nvidia/nemotron-3.5-super-vl:free
```

The game starts once every player has joined. Each laptop then checks the result for itself, prints
the winner, and writes `viewer/replay.json`. Run `npx serve viewer` on any laptop to watch it.

## Good to know

- Every laptop should print the same winner. That's the project's whole point, so show it in the demo.
- Each laptop's viewer only shows the chat that player received, because messages are private.
- If a player disconnects, the others wait 30 seconds (90 with AI) and then vote them out.
- A new game needs a new `game.json`, because a game id can only be played once. Restart the relay too.
- Anyone on the network can reach the relay while it's running. Fake events get rejected, but stop it
  after the game.

## If something goes wrong

| Problem | Fix |
|---|---|
| `relay connection failed` | Check the address, that the relay is running, and the host's firewall |
| `This key is not on the roster` | The host needs your public key in `game.json` |
| Stuck on "Waiting for the others" | Someone hasn't joined yet. Check everyone has the same game id |
