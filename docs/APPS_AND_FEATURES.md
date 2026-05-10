# tir — apps & features (living brainstorm)

Use this file to keep agents and the team aligned on **what we're
building next**. Move items between sections as they progress.

> Sister files:
> [`AGENTS.md`](../AGENTS.md) ·
> [`BLUEPRINT.md`](../BLUEPRINT.md) ·
> [`DEVELOPER_GUIDE.md`](./DEVELOPER_GUIDE.md) ·
> [`DESIGN.md`](./DESIGN.md)

---

## 0. North star + non-negotiables

- **DAU is the single metric.** Everything ships if it grows DAU
  without inviting toxicity, pay-to-win, or solvability.
- **Hard non-goals:** pay-to-win, optimal-path solvability,
  open-text social channels, gambling-coded reward UX.

---

## 1. Currently building

- [ ] **aaam.dev rebrand of the app shell.** Rename slug, bundle id,
      Apple App Store Connect record, Firebase iOS/Android app
      records under team `D92AD98B9B`. Land before any external
      sharing.
- [ ] **Visual identity pass on the single screen.** Apply
      [`DESIGN.md`](./DESIGN.md) tokens; wire Reanimated 4 motion
      tokens; `Pressable` not `TouchableOpacity`; tab-bar / nav
      placeholders.
- [ ] **Multi-screen IA via Expo Router.** Onboarding → Home →
      Game → Profile → Results. `App.tsx` becomes one route.
- [x] **Semantic word engine (GloVe).** ~900 curated common words with
      meaning-based neighbors (GloVe 300d, not character-level). Pipeline:
      `pipeline/build_neighbors.py`. Data: `precomputed/neighbors/words/{word}`.
      Lexical overlap filter strips spelling-similar noise.
- [ ] **Idempotent finalize + reward locks.** Drop a
      `finalizeLocks/{roomId}_{roundSeq}` doc inside the txn so
      concurrent calls don't double-credit.

---

## 2. Next up (Phase 2 — depth + retention)

- [ ] **Rerolls.** Earned per round / per streak; replaces all 4
      options; new callable `reroll(roomId)`; player-doc field
      `rerollsAvailable: number`.
- [ ] **Win-streak reset on loss.** When a user is in
      `allPlayerUids` but not the winner / photo-finisher, set
      `winStreak = 0`.
- [ ] **Daily streak.** Compare `lastPlayedDay` with yesterday in
      a chosen tz; bump or reset; surface on Profile.
- [ ] **Event feed.** Write
      `rooms/{id}/events/{autogen}` for `playerReachedTarget`,
      `finishWindowStarted`, `newTarget`. Render a small "killfeed"
      strip in the HUD.
- [ ] **Anti-bot rate limit.** Reject submits with cadence > ~5/sec
      per uid; log to `abuseSignals/{uid}`.
- [ ] **Global shard rotation.** Roll a new shard daily, or when
      memberIds grows past N (decide N from telemetry).
- [ ] **Daily seed target.** A featured "target of the day" arc on
      top of the rotating targets, for return-visit reasons.
- [ ] **Reward formula upgrades.** Layer placement + final-distance
      + speed + upset + comeback + population multipliers as
      additive Elo deltas, capped per round.

---

## 3. Phase 3 — social + cosmetics

- [ ] **Friends + display names.** Right now we render
      `uid.slice(0,6)`. Add an editable `displayName` to `users/{uid}`
      and a `friends/{uid}_{otherUid}` collection (or top-level
      `friends/{uid}` doc with arrays).
- [ ] **Parties / private invites.** First-class invite link → join
      flow into a private room.
- [ ] **Emoji-only chat.** Per-room ephemeral reactions (TTL ~30s),
      capped to a 12-emoji palette. Per `QUESTIONS.md` §11.
- [ ] **Cosmetics shop (no power).** Tasteful avatar / name color /
      theme tints. Probably non-monetized at first.
- [ ] **Hindi rollout.** Multilingual GloVe or fastText embeddings
      for Hindi semantic neighbors; per-room language flag.

---

## 4. Polish + quality-of-life

- [ ] Real **display names** in roster + on the FINISH WINDOW banner.
- [ ] **Round summary card** at the end of each round (winner, your
      placement, Elo delta).
- [ ] **Personal stats** page on Profile (lifetime won, photo-finishes,
      best streak, league progress bar).
- [ ] **Better empty states** when shard is empty / waiting for
      players.
- [ ] **Accessibility audit** — VoiceOver labels on every option,
      Dynamic Type behaviour, reduce-motion timeline.

---

## 5. Idea parking lot (not committed; debate first)

- **Personalization slot.** One of the 4 options gently biased to a
  user-level long-term affinity (most-picked semantic domain) for
  *subtext* without unfairness. Risk: leaks competitive advantage to
  long-time users — needs a careful experiment.
- **Daily challenges.** "Get to 'snow' from 'fire' in ≤ 6 moves" as
  a solo side-quest. Earns rerolls.
- **Replay diff.** After a round, show your path next to the winner's
  path. Pure post-game; doesn't slow live play.
- **"Co-op pool" mode.** Everyone in the shard contributes to a
  shared progression (e.g. 100 collective wins → unlock a community
  cosmetic). Tests social-prosocial design without team mechanics.
- **Boss targets.** Occasionally inject a deliberately-hard target
  (low connectivity in the semantic neighbor graph). Reward bigger but rare.
- **Spectator-by-default for first 60s after install.** Watch a live
  round before joining one. Lowers cold-start anxiety.
- **"Word of the day" notification opt-in.** One push at 10am local
  with a curated target; tap → straight into a fresh global shard.
- **Apple Watch glance.** Last round's outcome + Elo delta. No
  active gameplay, just a peek.
- **iMessage extension.** Send a custom challenge to a friend
  ("Beat my path: fire → ice in 5 moves").

---

## 6. Things we explicitly will NOT build

- **Open-text chat.** Toxicity risk too high; emoji-only is the
  decided answer.
- **Skill-based matchmaking with arenas.** Decided in
  [`QUESTIONS.md` § 5](../QUESTIONS.md): no arenas, no matchmaking.
- **Hint power-ups.** Anti-pay-to-win + anti-solvability; rerolls are
  the only assist.
- **Time-boxed rounds with leaderboards.** Decided no in
  [`QUESTIONS.md` § 3](../QUESTIONS.md).
- **A "warmer / colder" hotness meter.** Decided no in
  [`QUESTIONS.md` § 2](../QUESTIONS.md). Distance stays hidden.
- **Numeric distance display anywhere.** Same reason.
- **A Battle Pass.** Per `QUESTIONS.md` § 8.

---

## 7. Open product questions

1. **Monetization.** Free + cosmetic shop? Paid app? Ads on round
   transitions? Decide after Phase 1 telemetry.
2. **Per-shard population scaling.** When does a shard feel "too
   crowded" or "too empty"? Need live telemetry to size
   `SHARD_COUNT` and rotation cadence.
3. **Hindi delivery.** One app with a language toggle vs `tir-hi`
   separate slug? Embedding-graph cost + namespace separation argue
   for separate; UX simplicity argues for toggle.
4. **Rewards on a single-player session.** When you spawn into a
   global shard with no one else online, does Elo still move? Today
   it does (you can still primary-win). Maybe scale by population.

---

*Edit freely. Mark ideas as `(rejected because …)` rather than deleting
them — preserves the lineage of why we didn't build something.*
