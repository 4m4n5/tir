# tir

> race from a word to a word, one of four steps at a time. first to
> land wins. you've got three seconds.

A fast-twitch mobile **semantic word-race** game. iOS + Android. Players
race from word to word by choosing options based on **meaning similarity**
(not spelling or letter patterns). The target is visible, the semantic
distance is hidden, and every move is one of four meaning-related options.
First player to hit the target triggers a dynamic finish window for
everyone else. Then a new target rotates in.

Built by [`aaam.dev`](https://aaam.dev).

**Platforms:** iOS · Android  
**Stack:** React Native (bare) + Expo dev-client + `@react-native-firebase` + Firebase Cloud Functions

---

## Docs for humans & agents

| Doc | Use |
|---|---|
| **[`AGENTS.md`](./AGENTS.md)** | **Start here** — agent entry point, repo map, conventions, current implementation status |
| **[`BLUEPRINT.md`](./BLUEPRINT.md)** | Full product + technical spec: loop, multiplayer, word engine, rewards, anti-cheat, data model, cost model, phased roadmap |
| **[`SETUP.md`](./SETUP.md)** | Machine setup: Node, Xcode, CocoaPods, Firebase CLI, running on device, deploying functions |
| **[`docs/DEVELOPER_GUIDE.md`](./docs/DEVELOPER_GUIDE.md)** | Architecture: client bootstrap, callable contracts, Firestore ownership, security, indexes, feature checklists |
| **[`docs/DESIGN.md`](./docs/DESIGN.md)** | Visual language: voice, palette, typography, motion tokens, components, accessibility |
| **[`docs/APPS_AND_FEATURES.md`](./docs/APPS_AND_FEATURES.md)** | Living brainstorm: current build, next up, idea parking lot |
| **[`QUESTIONS.md`](./QUESTIONS.md)** | Original game-design Q&A — the source of every product decision |

---

## What's playable today

Single-screen MVP (commit `bfe5158`):

- Anonymous Firebase auth
- **Create private room** (shareable room code)
- **Enter global shard** (3 UID-hashed shards)
- **Join by code**
- Pick one of 4 word options each move
- 3-second **finish window** banner when someone hits the target
- Elo + league band (Bronze → Diamond)
- ~900-word GloVe-powered semantic vocabulary (meaning-based neighbors, not character-based)

What's not done yet — see [`AGENTS.md` § 14](./AGENTS.md) and
[`docs/APPS_AND_FEATURES.md`](./docs/APPS_AND_FEATURES.md).

---

## Getting started

```bash
# Mobile app
cd TirApp
npm install
cd ios && bundle install && bundle exec pod install && cd ..
npx expo run:ios --device      # or: npx expo run:android

# Cloud functions
cd ../functions
npm install && npm run build
cd ..
firebase deploy --only functions,firestore:rules
```

Full prerequisites + troubleshooting: [`SETUP.md`](./SETUP.md).

> **Heads up:** tir uses `@react-native-firebase/*` (native modules),
> so it **cannot** run in Expo Go. You always build a custom dev
> client.

---

## Status

- [x] Phase 0: gameplay loop + finish-window + Elo (single screen)
- [x] Phase 1: semantic word engine (GloVe embeddings, ~900 curated words) ·
      real Elo + partial rewards · identity (name/avatar) · leaderboard ·
      motion/haptics · daily streaks · idempotent rewards
- [ ] Phase 2: rerolls · event feed · anti-bot · shard rotation
- [ ] Phase 3: friends · emoji chat · cosmetics · Hindi
- [ ] Phase 4: store launch under `aaam.dev/tir/`

Roadmap detail in [`BLUEPRINT.md` § 10](./BLUEPRINT.md).

---

*Personal-studio project — not for redistribution.*
