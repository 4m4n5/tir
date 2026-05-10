# tir — setup guide

Use this to run the app on a fresh machine. Architectural overview for
agents lives in [`AGENTS.md`](./AGENTS.md). Product spec in
[`BLUEPRINT.md`](./BLUEPRINT.md).

> **Important constraint up front:** tir uses
> `@react-native-firebase/*` (native modules), so it **cannot** run
> in Expo Go from the App Store. You build a custom dev client with
> `expo run:ios` / `expo run:android` and install it on a real
> device or simulator.

---

## 1. Requirements

| Tool | Version | Notes |
|---|---|---|
| **Node** | ≥ 20 LTS | both `TirApp/` and `functions/` `engines.node` say `20` |
| **npm** | ships with Node | — |
| **Xcode** | ≥ 16 (current author tested 26.4.1) | iOS device builds, signing |
| **CocoaPods** | ≥ 1.15 | needs Ruby ≥ 3.0; macOS system Ruby (2.6) is too old |
| **Ruby** | ≥ 3.0 (via `rbenv` / `chruby`) | for CocoaPods; `Gemfile` already pinned |
| **Bundler** | ≥ 2.0 | `bundle exec pod install` is the supported path |
| **Java JDK** | 17 | Android Gradle build |
| **Android Studio** | latest | for `expo run:android` + emulators |
| **Firebase CLI** | latest | `npm i -g firebase-tools` |

Sanity-check on macOS:

```bash
node -v          # v20+
ruby -v          # 3.0+ (NOT system 2.6)
bundle -v        # 2.x
pod --version    # 1.15+
java -version    # 17.x
xcodebuild -version
firebase --version
```

If `pod` is missing or Ruby is system 2.6:

```bash
# Recommended: install rbenv + a modern Ruby once
brew install rbenv ruby-build
rbenv install 3.3.5
rbenv global 3.3.5
gem install bundler
gem install cocoapods
```

---

## 2. Repo layout

The repo has **two npm workspaces side by side** (no monorepo
tooling — just two folders, each with its own `package.json`):

```
tir/
├── TirApp/        ← React Native bare app (expo-dev-client)
│   ├── App.tsx    ← single-screen UI today; will become routes in Phase 1
│   ├── ios/       ← Xcode project + Pods
│   ├── android/   ← Gradle project
│   └── src/       ← rooms/, wordEngine/, firebase/
└── functions/     ← Firebase Cloud Functions (Node 20, TypeScript)
    └── src/       ← callables.ts, stub.ts, embeddingNeighbor.ts, …
```

`firebase.json`, `firestore.rules`, `firestore.indexes.json`, and
`.firebaserc` (project id `tirapp-c596f`) live at the **repo root** —
that's where you run `firebase deploy …` from.

---

## 3. Install dependencies

```bash
# Mobile app
cd TirApp
npm install
cd ios
bundle install
bundle exec pod install   # 5–10 min on first run; the Podfile has fmt-v11 workarounds baked in
cd ../..

# Cloud Functions
cd functions
npm install
npm run build
cd ..
```

---

## 4. Firebase project

Default project is `tirapp-c596f` (in `.firebaserc`). For development
on the existing project:

```bash
firebase login                # one-off per machine
firebase use tirapp-c596f     # confirm the active project
```

If you are bringing up a fresh Firebase project (e.g. for a rebrand):

1. Firebase console → **Add project**.
2. Authentication → enable **Anonymous**.
3. Firestore → Create database → start in production mode (we have
   strict rules; nothing is open-by-default).
4. Add an iOS app (bundle id matches `app.json`) and download
   `GoogleService-Info.plist` to `TirApp/ios/GoogleService-Info.plist`
   *and* `TirApp/ios/TirApp/GoogleService-Info.plist` (both paths are
   referenced by Xcode).
5. Add an Android app (package matches `app.json`) and download
   `google-services.json` to `TirApp/android/app/google-services.json`.
6. Update `.firebaserc` with the new project id.
7. `firebase deploy --only firestore:rules,firestore:indexes`.

---

## 5. Run the app on a device

> Reminder: Expo Go will **not** work because of the native Firebase
> modules. You need the dev client.

### iOS (recommended for v0.1 dev loop)

1. Plug in an iPhone (USB or Wi-Fi pairing).
2. Open `TirApp/ios/TirApp.xcworkspace` in Xcode → select the
   `TirApp` target → **Signing & Capabilities** → set the team to
   your Apple developer team (studio team is `D92AD98B9B`). Trust
   the developer profile on the phone (Settings → General → VPN &
   Device Management) the first time.
3. From `TirApp/`:

   ```bash
   npx expo run:ios --device
   ```

   The first build is slow (Pods + native compile). Subsequent JS-only
   changes hot-reload via Metro.

4. Once installed, you can run `npm start` from `TirApp/` to relaunch
   Metro without rebuilding the native binary.

### Android

```bash
cd TirApp
npx expo run:android
```

(Untested on this commit per `AGENTS.md` § 14 — expect a handful of
gradle / signing fixes the first time.)

### Simulator caveats

- Anonymous auth works on the iOS simulator.
- The simulator often has **Reduce Motion** enabled by default. Many
  reveal animations will silently snap. Settings → Accessibility →
  Motion → Reduce Motion → off, or look for the
  `[Reanimated] Reduced motion setting is enabled on this device`
  warning at app launch.

---

## 6. Cloud Functions

### Deploy (live project)

```bash
cd functions
npm install
npm run build
cd ..
firebase deploy --only functions
firebase deploy --only firestore:rules
# or: firebase deploy --only functions,firestore:rules
```

Region is hardcoded to `us-central1`. All callables live there.

### Local emulator

```bash
cd functions
npm run serve     # builds + starts emulator for functions + firestore
```

Then in `App.tsx` (temporarily, for local dev):

```ts
import functions from '@react-native-firebase/functions';
import firestore from '@react-native-firebase/firestore';
functions().useEmulator('localhost', 5001);
firestore().useEmulator('localhost', 8080);
```

iOS simulator can hit `localhost`. Real devices need your machine's
LAN IP instead of `localhost`.

---

## 7. Word engine config (semantic similarity)

tir is a **semantic matching game** — words are connected by **meaning**,
not by spelling or letter patterns. The engine uses precomputed GloVe
(word co-occurrence) embeddings to ensure genuine semantic neighbors.

- **Production engine: GloVe precomputed neighbors**
  - ~900 curated, common English words with top-50 semantic neighbors each.
  - Data lives in Firestore at `precomputed/neighbors/words/{word}`.
  - No API keys needed — everything is precomputed offline.

- **Rebuilding the word graph** (when adding words or tuning):

  ```bash
  cd pipeline
  # Download GloVe vectors (first time only — ~800MB zip)
  curl -L -o glove.6B.zip https://nlp.stanford.edu/data/glove.6B.zip
  unzip -o glove.6B.zip glove.6B.300d.txt
  # Run pipeline + upload to Firestore
  pip3 install numpy tqdm gensim firebase-admin
  python3 build_neighbors.py --upload
  # Clean up large files
  rm glove.6B.zip glove.6B.300d.txt
  ```

  Edit `SEED_WORDS` in `build_neighbors.py` to add/remove vocabulary.
  The lexical overlap filter automatically strips character-similar neighbors.

- **Stub fallback:** 28-word hand-curated graph in `functions/src/stub.ts`.
  Used only when a word is missing from precomputed data.

---

## 8. Firestore indexes

The repo ships an empty `firestore.indexes.json` — no composite
indexes are needed yet because all queries are single-field
(`onSnapshot` on a doc or a small subcollection). Deploy is still a
no-op-friendly:

```bash
firebase deploy --only firestore:indexes
```

When the planned **event feed** lands (Phase 2) it will need a
composite on `rooms/{id}/events` `(type, createdAt desc)`.

---

## 9. Common toolchain pitfalls

| Symptom | Likely cause | Fix |
|---|---|---|
| `pod install` chokes on `fmt` consteval errors | Apple clang + fmt v11 incompat | The Podfile already patches this; if you bumped fmt manually, revert. |
| `Ruby` errors during `pod install` | macOS system Ruby (2.6) | Install rbenv + Ruby 3.x. |
| `firebase` command not found | CLI not installed | `npm i -g firebase-tools` |
| iOS build fails on signing | No team selected | Open `TirApp.xcworkspace` → target → Signing & Capabilities → set team `D92AD98B9B`. |
| `FirebaseApp.configure()` crash on launch | Missing or wrong `GoogleService-Info.plist` | Ensure plist exists in **both** `TirApp/ios/` *and* `TirApp/ios/TirApp/`. |
| Expo Go shows a blank screen | Expo Go doesn't support native Firebase modules | Use `npx expo run:ios --device` instead. |
| `permission-denied` writing Firestore | Working as intended | Clients are read-only. All writes go through Cloud Functions callables. |
| Pods folder missing | First-time setup | `cd TirApp/ios && bundle exec pod install` |

---

## 10. EAS / store builds

Not configured yet. We'll add `eas.json` and an EAS project linkage in
**Phase 1** along with the `aaam.dev` rebrand. Mirrors humm's setup
([`humm/eas.json`](../humm/eas.json) — `preview` = APK, `production` =
AAB).

---

## 11. Where to look next

- **Architecture & code map** → [`docs/DEVELOPER_GUIDE.md`](./docs/DEVELOPER_GUIDE.md)
- **Product spec** → [`BLUEPRINT.md`](./BLUEPRINT.md)
- **Game design Q&A (origin doc)** → [`QUESTIONS.md`](./QUESTIONS.md)
- **Visual language** → [`docs/DESIGN.md`](./docs/DESIGN.md)
- **Idea backlog** → [`docs/APPS_AND_FEATURES.md`](./docs/APPS_AND_FEATURES.md)
