# Game rules (v1)

This captures the concrete v1 rules implied by `QUESTIONS.md`.

## Visibility

- Target word: **visible**
- Numeric distance: **hidden**

## Timing

- Rounds are continuous.
- When a player reaches the target:
  - Start a **3 second finish window** for everyone (global banner).
  - Anyone who reaches within the window gets a secondary recognition/bonus.
  - After the window expires, a new target is chosen for the room and play continues from each player’s current word.

## Moves

- Each move: player selects **1 of 4** options.
- Reroll: replaces **all 4** options (earned, not bought).

## Multiplayer topology

- “Global” is implemented as large **rotating rooms** (shards) behind the scenes.
- Private rooms exist for friends.

## Join seeding

- When a player joins mid-round: assign a starting word from a randomized band **behind** the median distance of active players (median over recent ~5 seconds).

## Anti-cheat posture (v1)

- Basic anti-bot and rate-limiting.
- Hide numeric distance.