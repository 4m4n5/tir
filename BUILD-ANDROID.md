# Build Android — APK to share with friends

The recipe for producing a release-signed APK of tir that friends can
sideload onto an Android phone. No Play Store, no Google Play Console,
no Android SDK install on the build machine. Uses **EAS Build** (Expo's
cloud CI) so a clean machine with just `node` + `eas-cli` is enough.

Companion docs:
- `SHIP.md` — iOS App Store recipe
- `STORE.md` — App Store metadata source-of-truth

---

## Why EAS Build for Android (not local Gradle)

Local Gradle requires JDK 17, Android SDK, NDK, build-tools, platform-tools,
~10 GB of disk, and ~1–2 hours of one-time setup. For the "share an APK
with 5 friends" use case, EAS Build is the right tradeoff:

- One command (`eas build --profile preview --platform android`)
- Cloud build (5–15 min in queue + ~8 min build time)
- Returns an `https://expo.dev/artifacts/...` URL with the APK
- Auto-managed keystore (Expo holds the signing key for you)
- Free tier is enough for personal-scale builds

If you ever want to ship to Play Store, switch the profile to `production`
(set up below) and EAS will output an AAB instead.

---

## Prereqs on the build machine

One-time setup. Skip what you already have.

1. **Node 20.x** (`brew install node@20` or `nvm install 20`).
2. **eas-cli** installed globally:
   ```bash
   npm install -g eas-cli
   ```
3. **Expo account** — log in once with:
   ```bash
   eas login
   ```
   Use the same Expo account as `humm` (which already has `projectId`
   `30c5357d-ddd0-490b-a158-fd22c872392e` registered). Email + password
   you set up when you first ran EAS for hum.

---

## First-time project linkage

If this is the very first EAS command run from `TirApp/`:

```bash
cd TirApp
eas init
```

EAS will create a new Expo project, generate a `projectId` UUID, and
add it to `app.json` under `expo.extra.eas.projectId`. Commit that.

After that, every subsequent `eas build` command knows which project
this is.

---

## Build the APK

```bash
cd TirApp
eas build --profile preview --platform android
```

What happens:
1. EAS CLI uploads your source to Expo's cloud build server.
2. Expo runs `./gradlew assembleRelease` in their build container with
   the right Android SDK version pinned.
3. Expo signs the APK with the **managed keystore** they generated and
   stored for `com.tirapp` (first time only — they'll prompt you to
   confirm "Generate a new keystore?" → answer **yes**).
4. After 5–15 min, the CLI prints a URL like
   `https://expo.dev/accounts/<you>/projects/tir/builds/<uuid>`
5. Open that URL in a browser → click "Download APK".

---

## Share with friends

You have three options to distribute the APK.

### Option 1 — Send the Expo URL directly (simplest)

The build page on `expo.dev` has a direct download link. Send the link
to friends. They open it on their Android phone in Chrome, tap
"Download", then tap the downloaded `.apk` file. Android prompts:

> "Chrome needs permission to install unknown apps."
> → Settings → Install unknown apps → Chrome → enable

Then they install. ~2 taps after the warning.

### Option 2 — Host on aaam.dev (cleanest URL)

```bash
# Download the APK locally
curl -L -o /tmp/tir-1.0.0.apk '<paste the expo download URL>'

# Move into aaam.dev
mkdir -p /path/to/aaam.dev/tir/download
mv /tmp/tir-1.0.0.apk /path/to/aaam.dev/tir/download/tir-latest.apk

# Commit + push
cd /path/to/aaam.dev && git add tir/download/tir-latest.apk && \
  git commit -m "tir: ship v1.0 android apk" && git push
```

Cloudflare Pages serves it. Share `https://aaam.dev/tir/download/tir-latest.apk`.
The trust signal of a clean `aaam.dev` URL is worth the extra steps —
some Android phones flag random `expo.dev` URLs.

### Option 3 — Google Drive / Dropbox

Upload the APK to Drive, generate a share link, send. Works fine but
has the lowest trust signal (Drive's preview UI for APKs is awkward).

---

## Versioning rules

| When | Bump |
|---|---|
| First build | `versionCode = 1` (set in `app.json` → `expo.android.versionCode`). Already done. |
| Subsequent build, same release | Bump `versionCode` by 1 (e.g. `1` → `2`). Required by Android: every APK on a device must have a strictly higher versionCode to install over the previous one. |
| New release (1.0.0 → 1.0.1) | Bump both `expo.version` AND `expo.android.versionCode`. |

EAS prebuild writes these into `android/app/build.gradle` automatically
at build time.

---

## Common gotchas

| Problem | Cause | Fix |
|---|---|---|
| `eas init` says "Project already linked" | `extra.eas.projectId` exists | Skip `eas init`, go straight to `eas build`. |
| Friends say "Can't install — app not installed" | A different signed copy of `com.tirapp` is already on the device | Uninstall the old copy first (Settings → Apps → tir → Uninstall), then install. |
| `Build failed` with `Cannot find module @react-native-firebase/...` | Yarn/npm lockfile mismatch | `cd TirApp && rm -rf node_modules && npm install` before retrying. |
| `Build failed` with `google-services.json not found` | The file path in `app.json` is wrong | Confirm `TirApp/android/app/google-services.json` exists (committed). |
| Friend opens APK on iPhone | iOS can't install APKs | They need an Android phone, or wait for the iOS App Store release. |
| APK is rejected with "app not optimized for newer Android" | targetSdkVersion below Play Store min | Not a real-world issue for sideload; Play Store cares, friends don't. |

---

## What "preview" buys you vs "production"

- `preview` → **APK**, `internal` distribution, release-signed.
  Right for: sharing with friends, beta testing, ad-hoc demos.
- `production` → **AAB** (Android App Bundle), suitable for Play Store
  submission. Cannot be installed directly — Play Store splits the AAB
  into device-specific APKs at install time.

Right now we have only `preview` set up. If/when you want to ship to
Play Store, the `production.android` profile in `eas.json` is already
written and ready to use.
