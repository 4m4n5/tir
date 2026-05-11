# Ship — build + upload tir to App Store from a clean machine

This doc is the recipe for producing a signed, App Store-ready IPA from a
fresh clone and uploading it. It exists because the original build machine
sits behind corporate DPI (CrowdStrike + Reddit network policy) that kills
multipart uploads to Apple's `northamerica-1.object-storage.apple.com` and
to `uploads.github.com`. Building + uploading from a personal laptop on a
residential / cellular network avoids the entire problem.

Companion doc: `STORE.md` is the App Store Connect metadata source-of-truth
(name, subtitle, description, keywords, screenshots, privacy answers).

---

## Prereqs on the build machine

One-time setup. Skip what you already have.

1. **Xcode 16+** (App Store) — signs in with your Apple Developer Apple ID
   under Xcode → Settings → Accounts. The team `D92AD98B9B` (`aaam.dev`)
   must show up after sign-in. Same team that ships hum.
2. **Node 20.x** (`brew install node@20` or `nvm install 20`).
3. **CocoaPods** (`sudo gem install cocoapods` — or `bundle install` from
   `TirApp/` to use the project's pinned Gemfile version).
4. **Transporter.app** (free, Mac App Store) — for the actual upload step.
   <https://apps.apple.com/us/app/transporter/id1450874784>

---

## Steps

```bash
# 1. Clone (or pull latest if already cloned).
git clone https://github.com/4m4n5/tir.git
cd tir/TirApp

# 2. Install JS deps (~2 min).
npm install

# 3. Install iOS deps via the project's pinned CocoaPods (~3 min).
cd ios
bundle install         # uses Gemfile to pin the cocoapods version
bundle exec pod install
cd ..

# 4. Archive (~4-6 min). Produces /tmp/TirApp.xcarchive.
#    The first archive on a new machine takes longer because Xcode
#    has to create the App Store Distribution provisioning profile;
#    -allowProvisioningUpdates lets it do that automatically.
rm -rf /tmp/TirApp.xcarchive
xcodebuild \
  -workspace ios/TirApp.xcworkspace \
  -scheme TirApp \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath /tmp/TirApp.xcarchive \
  -allowProvisioningUpdates \
  archive

# 5. Export App Store-signed IPA (~30 sec). Produces /tmp/TirApp-export/TirApp.ipa.
#    ios/ExportOptions.plist is in the repo and pre-configured for
#    method=app-store-connect, signingStyle=automatic, teamID=D92AD98B9B.
rm -rf /tmp/TirApp-export
xcodebuild -exportArchive \
  -archivePath /tmp/TirApp.xcarchive \
  -exportOptionsPlist ios/ExportOptions.plist \
  -exportPath /tmp/TirApp-export \
  -allowProvisioningUpdates

# 6. Confirm the IPA exists and is App Store-signed (~27 MB, codesign Apple Distribution).
ls -lh /tmp/TirApp-export/TirApp.ipa
codesign -dv --verbose=2 /tmp/TirApp-export/TirApp.ipa 2>&1 | grep -E 'Authority|Identifier|TeamIdentifier'

# 7. Upload via Transporter (GUI, ~2 min on a clean network).
#    open Transporter.app, sign in, drag /tmp/TirApp-export/TirApp.ipa
#    into the window, click Deliver.
open -a Transporter /tmp/TirApp-export/TirApp.ipa
```

After Deliver succeeds, Apple's processing takes 5-30 min. The build then
appears in App Store Connect → TestFlight → iOS Builds for tir
(`https://appstoreconnect.apple.com/apps/6768131124`).

---

## Versioning rules for v1.1+

You will need to bump these BEFORE running step 4, otherwise Apple rejects
the upload with `ITMS-90062` "build number must be greater":

- `TirApp/ios/TirApp.xcodeproj/project.pbxproj` — `MARKETING_VERSION`
  (user-visible version, e.g. `1.0.0` → `1.0.1`) AND
  `CURRENT_PROJECT_VERSION` (build number, e.g. `1` → `2`). Both Debug
  and Release configs.
- For pure rebuilds of the same version (rare — only if a previous upload
  was rejected by Apple before processing), only `CURRENT_PROJECT_VERSION`
  needs to bump.

---

## Common gotchas

- **"No accounts with iTunes Connect access"** during archive — Xcode →
  Settings → Accounts → "+" → Apple ID → sign in with the developer
  account (the one that owns the `D92AD98B9B` team).
- **"No profile for team matching"** during export — first archive on a
  machine. The `-allowProvisioningUpdates` flag lets Xcode create the
  Distribution profile on the fly. If it still fails, open the project in
  Xcode once, click Signing & Capabilities, let it auto-fix, then retry.
- **`pod install` fails on M-series Macs** — `cd ios && arch -x86_64 bundle exec pod install`.
- **Transporter upload stalls / fails** — the build machine is on a
  corporate / DPI'd network. Phone hotspot fixes it.
- **Apple rejects build with "Missing Privacy Manifest"** — `ios/TirApp/PrivacyInfo.xcprivacy`
  is in the repo and gets bundled by the archive. If the warning appears,
  confirm the file is in the build phase: Xcode → TirApp target → Build
  Phases → Copy Bundle Resources → contains `PrivacyInfo.xcprivacy`.

---

## Why this doc exists (don't re-debate)

- Repo source-of-truth: every upload comes from a `git pull` + `npm install` + `bundle exec pod install` + archive. No hand-built local state. Anyone with the team can ship.
- No CI for this step yet because (a) the dev cycle is solo, (b) EAS Build is overkill for one platform, (c) GitHub Actions on the free tier doesn't have macOS arm64 minutes for archiving in a reasonable time. When v2.0 needs Android too or we add a second engineer, revisit with EAS Build or self-hosted GitHub Actions runner.
