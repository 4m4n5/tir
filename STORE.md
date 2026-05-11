# tir — App Store metadata kit

This document is the source-of-truth for App Store Connect submission and
marketing surfaces. It encodes the brand voice, the legal must-haves, and
the ASO field budgets. Re-read before any release.

> Drafted 2026-05-10 against ASO 2026 best practices ([AppDrift 2026](https://appdrift.co/blog/app-metadata-optimization-guide),
> [Sonar 2026](https://trysonar.app/blog/metadata-optimization-guide),
> [ASO World 2026](https://asoworld.com/insight/app-store-search-algorithm-2026-what-actually-decides-your-keyword-ranking/)).
> Apple [App Store Connect Reference](https://developer.apple.com/help/app-store-connect/reference/) for current field limits.

---

## Brand snapshot

- **App**: tir — a fast-paced word race
- **Studio**: aaam.dev
- **Bundle ID**: `com.tirapp`
- **App Store Connect App ID**: `6768131124`
- **Apple Team ID**: `D92AD98B9B` (shared with hum)
- **Category (primary)**: Games → Word
- **Category (secondary)**: Games → Puzzle
- **Age rating**: 4+ (no objectionable content; chat is server-mediated word picks only)
- **Pricing**: Free, no IAP, no ads (initial release)
- **Languages at launch**: English (US)

---

## App name (30 chars max)

**Use:** `tir: word race` — 14 chars
**Why:** brand-led, primary keyword "word race" present, no fluff. Title is the most-weighted search field ([Sonar 2026](https://trysonar.app/blog/metadata-optimization-guide)). We resist "tir - the word racing game" (28 chars) because the inflated suffix dilutes brand and reads as SEO desperation.

Alt if we want more keyword surface: `tir - word race game` (20).

---

## Subtitle (30 chars max)

**Use:** `race friends to the target word` — 31 chars (one over) → `race to the target word` — 23 chars
**Why:** second-most-weighted field. Names a benefit ("race") and a noun ("target word") that don't repeat the title. Apple deduplicates across fields, so "word" appearing in both title and subtitle is wasted.

Alt: `multiplayer word association` — 28 chars (better keyword density, weaker emotional pull).

---

## Promotional text (170 chars, NOT indexed)

**Use:**

> the chase is meaning. a target appears, you race through chains of meaning to reach it. closest pick wins the leap. one global room, real opponents. drop in.

(159 chars)

**Why:** promo text is editable without resubmitting a build, so use it for what changes — current vibe, seasonal hooks, "just shipped" notes. NOT for SEO ([Sonar 2026 §promo](https://trysonar.app/blog/metadata-optimization-guide)).

---

## Description (4000 chars; first 3 lines visible without "More")

```text
race through meaning to a target word.

a target word appears. from any starting word, you pick the option whose meaning is closest. your current word jumps to that pick, four new options appear. keep picking. first mind to land on the target wins the round.

how it works
- a target word goes live in the global room
- you start somewhere unrelated and pick toward it
- closer meaning = bigger leap
- first to land on the target wins the round

what makes it different
- semantic, not lexical. you win on what words MEAN, not on spelling tricks.
- a real game, not a daily puzzle. drop in for a round, climb your rating, leave.
- one global room of real opponents. play solo at off-peak — solo wins still earn rating.
- pure pairwise Elo, the same math chess uses. no luck, no power-ups, no IAP, no ads.

ranking
- five-round placement period. your real rating is hidden until you have a sample.
- after that: a number, a tier, a leaderboard.
- losing to someone far above you barely costs you. beating someone far below barely earns you. honest math.

private rooms
- 4-character code, share with friends.
- four difficulties: chill, normal, hard, expert. (the global room is normal.)
- private rooms don't move your global rating. practice freely, race friends fairly.

shipped by aaam.dev. quiet, fair, fast.
```

(~1380 chars; well within budget; tight first-line hook that names the actual mechanic, not a fabricated timer)

**Voice rules** (echoing tir's in-app microcopy):

- lowercase everywhere
- no exclamation points
- no marketing puffery ("the best", "amazing", "addictive")
- list bullets use "-" not "•" or emoji bullets
- character > brevity: keep "shipped by aaam.dev. quiet, fair, fast." as the signature

---

## Keywords (100 chars, comma-separated, NO spaces after commas)

**Use:**

```
synonym,vocabulary,semantic,meaning,association,puzzle,brain,multiplayer,Elo,competitive,ranked,linguist
```

(100 chars)

**Why:** every keyword is missing from title/subtitle/description-noun-density. Apple deduplicates across all indexed fields, so we use this slot exclusively for keywords NOT used elsewhere. No `tir`, `word`, `race`, `target` (already in title/subtitle). No competitor brand names. Singular forms only ([Sonar 2026 §keywords](https://trysonar.app/blog/metadata-optimization-guide)).

**Dropped vs. v1:** `fast` (paired with the killed "90-second rounds" framing — speed is in the description, not a search term we want to compete on), `daily` (we explicitly position as "not a daily puzzle"), `trivia` (wrong genre — tir is association, not knowledge recall), `thesaurus` (overlaps with `synonym` and `vocabulary` for slot value). **Added:** `semantic`, `meaning`, `association` — the actual cognitive verb of the game and what a word-game enthusiast searching for "something like Codenames but solo" would type.

---

## What's New (4000 chars; per-release)

**v1.0 (initial release):**

```text
the first cut of tir.

- one global room, always on. drop in.
- closest meaning to the target wins the round.
- pure pairwise Elo, with a five-round placement grace.
- private rooms with four difficulties: chill, normal, hard, expert.
- 30-emoji avatar grid, 3-card tutorial, no signup.

shipped by aaam.dev. quiet, fair, fast.
```

---

## Support URL

`https://aaam.dev/tir/support`  *(create page; for now redirect to `mailto:support@aaam.dev`)*

## Marketing URL

`https://aaam.dev/tir`  *(landing page; reuses the aaam.dev shell with tir-specific app-card)*

## Privacy Policy URL

`https://aaam.dev/tir/privacy`  *(create page based on the data we collect — see §Privacy below)*

---

## Privacy: data collected

Required for the App Store privacy questionnaire ([Apple App Privacy](https://developer.apple.com/app-store/app-privacy-details/)).

| Data type | Collected | Linked to user | Used for tracking | Notes |
|---|---|---|---|---|
| Display name (chosen by user) | yes | yes | no | required to show in leaderboard / global room roster |
| Avatar (emoji choice) | yes | yes | no | display only |
| Anonymous user ID (Firebase Auth UID) | yes | yes | no | required for game state |
| Game-play stats (Elo, rounds, wins) | yes | yes | no | required for ranking |
| Device crash logs (Firebase) | yes (optional) | no | no | Firebase Crashlytics if enabled |
| Identifiers (IDFA, device IDs) | NO | n/a | n/a | not collected |
| Location | NO | n/a | n/a | not collected |
| Contacts / photos / health | NO | n/a | n/a | not collected |

Required disclosures:
- Account is anonymous by default; **no email, no phone, no password**.
- "Delete Account" inside the app permanently removes all linked data via a server-side Cloud Function. Apple App Review 5.1.1(v) compliant.

---

## Age rating questionnaire (Apple)

All categories: **None** except:

- Cartoon or fantasy violence: None
- Realistic violence: None
- Sexual content / nudity: None
- Profanity / crude humor: None
- Alcohol / tobacco / drugs: None
- Mature/suggestive themes: None
- Horror / fear: None
- Gambling: None
- Unrestricted web access: No
- User-generated content: **No**  (the only user input visible to others is the chosen display name + avatar; both pass through the server's contentPolicy check before being persisted)
- Medical/treatment info: No
- Political/religious: No

→ Result: **4+**

---

## Screenshots

Source: `TirApp/assets/screenshots/`. All 1320×2868 (App Store 6.9" portrait
required tier — Apple scales down to smaller iPhone sizes automatically per
[App Store Connect Reference](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications/)).

Upload order matters — the first three appear in search results.

| Slot | File | What it shows | Why this order |
|---|---|---|---|
| 1 | `06-game.png` | Live game: TARGET earthquake + 4 options | The product. Shown first because the game state is the differentiator, not the menu. |
| 2 | `05-home.png` | Home: tir wordmark, profile, LIVE round 37, PLAY, leaderboard | Proves the "always on" claim with a real round number + an actual leaderboard. |
| 3 | `02-tutorial-win.png` | "reach the target." | Sets the win condition in 4 words for browsers who tap-skim. |
| 4 | `03-tutorial-move.png` | "pick toward the target." | Explains the move heuristic. |
| 5 | `04-tutorial-sync.png` | "race together." | Multiplayer beat. 4 avatars + LIVE 4 PLAYERS. |
| 6 | `01-name.png` | Onboarding: 30-emoji avatar grid + name input | Lands the "no signup" claim visually. |

Caption text per slot (one-liners, ≤ 30 chars; **screenshot caption text is now a ranking signal** as of mid-2025 per [ASO World 2026](https://asoworld.com/insight/app-store-search-algorithm-2026-what-actually-decides-your-keyword-ranking/)):

1. `closest meaning, biggest leap`
2. `one global room, always on`
3. `first mind to the target wins`
4. `each pick is a leap`
5. `everyone races the same target`
6. `pick a name, pick a vibe`

---

## App icon

Source: `TirApp/assets/brand/icon-1024.png` (1024×1024, opaque RGB, no
alpha). Concept: "captured target" — outer cyan ring + offset cyan dot,
on the warm-near-black canvas. Sibling to humm's letterform mark, distinct
vibe (geometric vs. soft, electric vs. peach).

For Android Play Store and any iOS adaptive-icon variants we ship later,
re-render from `TirApp/assets/brand/icon-master.svg` via
`scripts/brand/generate-brand.py`.

---

## Bundle / build settings checklist

Before submission:

- [ ] `app.json` `expo.name` = "tir" (currently "TirApp")
- [ ] `app.json` `expo.slug` = "tir" (currently "tirapp")
- [ ] iOS `Info.plist` `CFBundleDisplayName` = "tir"
- [ ] iOS `Info.plist` `CFBundleShortVersionString` = "1.0.0"
- [ ] iOS `Info.plist` `CFBundleVersion` = "1"
- [ ] `expo` `ios.bundleIdentifier` = "com.tirapp" ✓
- [ ] `expo` `ios.buildNumber` = "1"
- [ ] LaunchScreen.storyboard color matches `colors.bg` ✓
- [ ] AppIcon.appiconset has 1024×1024 master ✓
- [ ] No raw hex outside `lib/theme.ts` ✓
- [ ] Production Firebase project (`tirapp-c596f`) is the build target ✓
- [ ] `firestore.rules` deployed ✓
- [ ] All Cloud Functions deployed ✓
- [ ] Privacy policy URL is live before submission

---

## Decisions log (so future-us doesn't re-debate)

- **App name with colon vs hyphen**: colon (`tir: word race`) reads more like a brand line than a hyphen (`tir - word race`). Both are within budget; colon wins on legibility.
- **No "ads-free" / "no IAP" in title or subtitle**: it's a flex but it eats keyword slots. We say it once in the description; Apple App Privacy section says it again.
- **Lowercase everywhere**: matches tir's in-app microcopy and the aaam.dev / humm family voice. Apple App Store doesn't auto-capitalize; this is a deliberate brand choice.
- **No video preview at launch**: the game's value is in the live race feel, which a 30s video can't capture without showing two phones at once. We'll add an app preview when we have a clean two-device split-screen recording.
- **No Android at launch**: SDK delta is mostly fine but we don't have a play-store account ready and the global-room economics are easier to validate one platform first.
