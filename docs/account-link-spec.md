# Account-link spec — Sign in with Apple + Google

**Status:** specced 2026-05-10, **not implemented**.
**Owner:** unowned. Pick this up when ready to ship account portability.
**Related:** AGENTS.md §16 "Account lifecycle (sign-out / delete)" — the
deletion path already exists; this spec layers in the *upgrade* path.

---

## 1. Goal

Today, every user is a Firebase anonymous account. If they uninstall the
app, lose their phone, or sign out, their uid is unrecoverable and their
rating / streaks / placement progress are gone. This spec adds a path to
**link the existing anonymous user to a permanent identity** without
losing data, so reinstalling on a new device restores the same uid.

**Not** a sign-in screen at app launch — onboarding stays anonymous-first
(Firebase canon: anon-first reduces sign-up drop-off, then prompt to
upgrade once the user has earned something worth saving). Citation:
[Firebase blog, "Best Practices for Anonymous Authentication"](https://firebase.blog/posts/2023/07/best-practices-for-anonymous-authentication).

---

## 2. Decisions made (already)

| Decision | Choice | Rationale |
|---|---|---|
| Auth providers | **Sign in with Apple + Sign in with Google** | Industry default for casual mobile games (Wordscapes, Angry Birds 2, Dragon City, EA Mobile all use this pattern). One-tap, biometric-backed, 98% device coverage. |
| Username/password | **No** | 2026 anti-pattern. Firebase blog explicitly cites password sign-up as the canonical onboarding-friction example. Passkeys/SSO are 30% faster, 2-6× higher conversion. |
| Email magic-link | **Deferred** | Adds value for the ~2% without Apple/Google but doubles the link UI surface. Revisit if metrics show non-trivial cohort failing to link. |
| Passkeys | **Deferred ~6-12mo** | The 2026-correct answer technically, but `@react-native-firebase/auth` doesn't natively support passkeys yet. Implementation paths today (JustPass extension, Clerk migration) are vendor-lock-y. Wait for first-class Firebase support. |
| Trigger placement | **Post-placement-ceremony + persistent settings CTA** | Highest-converting moment is right after the user earns a tier they don't want to lose. Settings entry catches everyone else. NN/g + growth.design canon: never prompt at first launch. |
| Copy framing | **"Save your progress"** (urgency framing) | Outcome-focused, names what the user has to lose. "Play on any device" (capability framing) is for a future tagline, not the primary trigger copy. |
| Apple App Store policy | **Auto-satisfied** | Sign in with Apple is itself the canonical "alternative" provider App Review 5.1.1(c) requires when offering Google sign-in. No additional surface needed. |

---

## 3. Native dependencies (one-time install)

```bash
cd TirApp
npm install @invertase/react-native-apple-authentication
npm install @react-native-google-signin/google-signin
```

Both are native modules; **`expo prebuild` will need to re-run** to
regenerate `ios/` and `android/`. The current Xcode project has manual
customizations (per `git status` modifications to
`ios/TirApp.xcodeproj/project.pbxproj` and the shared scheme) — back
those up before prebuild and reapply after.

Recommended sequence:

```bash
# 1. Stash local Xcode project mods
git stash push -m "xcode customizations" -- ios/TirApp.xcodeproj
# 2. Install packages
npm install @invertase/react-native-apple-authentication
npm install @react-native-google-signin/google-signin
# 3. Regenerate native projects
npx expo prebuild --clean
# 4. Re-pop Xcode mods
git stash pop
# 5. Manually merge the Sign in with Apple capability + Google URL scheme
#    into the regenerated pbxproj (or add via Xcode UI, see §4)
```

Alternative (lower-risk): use the [`@invertase/react-native-apple-authentication`
config plugin](https://github.com/invertase/react-native-apple-authentication#expo-config-plugin)
in `app.json` so prebuild handles the entitlements automatically.

---

## 4. External console setup (manual, ~45 min total)

### 4a. Apple Developer Portal (~10 min)

1. Sign in to [developer.apple.com](https://developer.apple.com), Account → Certificates, Identifiers & Profiles.
2. **Identifiers** → tap `+` → **Services IDs**. Description: `tir Sign in with Apple`. Identifier: `com.aaam.tir.signinwithapple` (any reverse-DNS, distinct from bundle ID). Enable **Sign In with Apple**, click Configure → primary App ID = `com.aaam.tir`, Web Domain = (Firebase auth domain, e.g. `tirapp-c596f.firebaseapp.com`), Return URL = `https://tirapp-c596f.firebaseapp.com/__/auth/handler`.
3. **Keys** → tap `+`. Name: `tir SiwA Key`. Enable **Sign in with Apple**. Configure → primary App ID = `com.aaam.tir`. Download the `.p8` file (one-time download, store securely). Note the **Key ID** (10-char string).
4. From the membership page, note the **Team ID** (10-char string).

### 4b. Google Cloud Console (~10 min)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials → select the `tirapp-c596f` project.
2. **Create Credentials** → OAuth 2.0 Client ID → **iOS**. Bundle ID: `com.aaam.tir`. Note the **iOS Client ID**.
3. Repeat for **Android**. Package name: `com.aaam.tir`. SHA-1 cert fingerprint: get via `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android` (debug) and the release keystore for production. Note the **Android Client ID**.
4. Repeat for **Web application**. Authorized redirect URI: `https://tirapp-c596f.firebaseapp.com/__/auth/handler`. Note the **Web Client ID** — this is the one Firebase Auth uses server-side; the iOS / Android client IDs are for the native pickers.

### 4c. Firebase Console (~5 min)

1. [console.firebase.google.com](https://console.firebase.google.com) → tirapp-c596f → Authentication → **Sign-in method**.
2. **Apple** → Enable. Service ID = `com.aaam.tir.signinwithapple`. Apple Team ID + Key ID + paste the `.p8` private key contents. Save.
3. **Google** → Enable. Web SDK configuration → paste the **Web Client ID** + Web Client Secret from Google Cloud Console. Save.
4. Re-download `GoogleService-Info.plist` (iOS) and `google-services.json` (Android) — Google sign-in needs the Web Client ID embedded in these. Drop into `TirApp/ios/TirApp/` and `TirApp/android/app/` respectively, replacing existing.

### 4d. iOS entitlements (~5 min)

Either via Xcode UI:
- Open `ios/TirApp.xcworkspace`, select TirApp target → Signing & Capabilities → `+` Capability → **Sign in with Apple**.

Or via the config plugin (preferred — survives prebuild):
- Add to `app.json`:
  ```json
  {
    "expo": {
      "ios": {
        "usesAppleSignIn": true,
        "infoPlist": {
          "CFBundleURLTypes": [
            { "CFBundleURLSchemes": ["com.googleusercontent.apps.<IOS_CLIENT_ID_REVERSED>"] }
          ]
        }
      },
      "plugins": [
        "@invertase/react-native-apple-authentication"
      ]
    }
  }
  ```

### 4e. Validation checklist

- [ ] `await appleAuth.isSupported()` returns `true` on iOS device.
- [ ] `GoogleSignin.hasPlayServices()` returns `true` on Android device.
- [ ] Firebase Auth provider list shows Apple + Google enabled.
- [ ] Test sign-in to a throwaway anon account links correctly and the new uid persists in `users/{uid}`.

---

## 5. Code changes

### 5a. New file: `TirApp/lib/authLink.ts`

Centralizes the link-credential logic for both providers. Uses
`linkWithCredential` against the existing anonymous user, preserving
the uid (per Firebase blog canon) so all rating/streaks/etc. are kept.

```ts
import auth, { FirebaseAuthTypes } from '@react-native-firebase/auth';
import { appleAuth } from '@invertase/react-native-apple-authentication';
import {
  GoogleSignin,
  statusCodes,
} from '@react-native-google-signin/google-signin';

// One-time configuration. Call from App boot (after Firebase init,
// before any sign-in attempts). Web Client ID from Firebase Console
// → Authentication → Google provider config (NOT the iOS or Android
// client ID — those are for the native pickers only).
export function configureGoogleSignIn(webClientId: string) {
  GoogleSignin.configure({ webClientId });
}

// Link the current (anonymous) user to a permanent Apple identity.
// Preserves the uid → all Firestore data is retained automatically.
//
// Throws on:
//   - User cancels Apple sheet (`appleAuth.Error.CANCELED`)
//   - Apple returns no identity token (rare; usually retry works)
//   - The Apple identity is already linked to a different uid
//     (`auth/credential-already-in-use`) — caller should offer to
//     sign in with that account instead, ABANDONING the current
//     anonymous progress (one-way per Firebase canon).
export async function linkAnonymousWithApple(): Promise<FirebaseAuthTypes.User> {
  const resp = await appleAuth.performRequest({
    requestedOperation: appleAuth.Operation.LOGIN,
    requestedScopes: [appleAuth.Scope.EMAIL, appleAuth.Scope.FULL_NAME],
  });
  if (!resp.identityToken) {
    throw new Error('Apple sign-in returned no identity token.');
  }
  const credential = auth.AppleAuthProvider.credential(
    resp.identityToken,
    resp.nonce,
  );
  const current = auth().currentUser;
  if (!current) throw new Error('No current user to link.');
  const result = await current.linkWithCredential(credential);
  return result.user;
}

// Link the current (anonymous) user to a permanent Google identity.
// Same uid-preserving semantics as Apple.
export async function linkAnonymousWithGoogle(): Promise<FirebaseAuthTypes.User> {
  await GoogleSignin.hasPlayServices();
  const userInfo = await GoogleSignin.signIn();
  const idToken = userInfo.data?.idToken;
  if (!idToken) throw new Error('Google sign-in returned no idToken.');
  const credential = auth.GoogleAuthProvider.credential(idToken);
  const current = auth().currentUser;
  if (!current) throw new Error('No current user to link.');
  const result = await current.linkWithCredential(credential);
  return result.user;
}

// True iff the current Firebase user has at least one non-anonymous
// provider linked. Drives:
// - identity-card "linked" badge on the home screen
// - whether the home footer shows "save your progress" or just "reset"
// - whether "reset progress" prompts for full delete vs simple sign-out
export function isCurrentUserLinked(user: FirebaseAuthTypes.User | null): boolean {
  if (!user) return false;
  return user.providerData.some(p => p.providerId !== 'anonymous');
}
```

### 5b. New screen: `TirApp/app/auth/link.tsx`

Bottom-sheet-style modal. Two stacked buttons (Apple-first on iOS,
Google-first on Android per platform convention), single dismiss
control, no email field (defer per §2).

Layout sketch:

```
┌─────────────────────────────────────┐
│            ━━ (drag handle)          │
│                                     │
│      💎  save your progress          │
│                                     │
│   sign in to keep your rating,       │
│   streaks, and stats safe across     │
│   devices.                           │
│                                     │
│  ┌───────────────────────────────┐  │
│  │       Continue with Apple     │  │  ← black bg, white text on iOS
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │      Continue with Google     │  │  ← white bg, gray border, G logo
│  └───────────────────────────────┘  │
│                                     │
│           not now                    │  ← text button, colors.dim
│                                     │
└─────────────────────────────────────┘
```

Token usage:
- Sheet: `colors.surface` bg, `radius.xl` top corners, `space[5]` H padding, `space[6]` V padding.
- Headline: `typo.heading`, `colors.text`, `space[3]` margin-bottom.
- Body: `typo.body`, `colors.muted`, `space[5]` margin-bottom.
- Apple button: bg `#000000` (Apple HIG-required), text `#FFFFFF`, height 50, `radius.md`. **Must use the official `AppleButton` component from `@invertase/react-native-apple-authentication`**, not a custom button — App Review may reject custom Apple sign-in buttons.
- Google button: bg `#FFFFFF`, text `#3C4043`, border `1px #DADCE0`, height 50, `radius.md`, with the official Google "G" logo to the left. **Must conform to [Google's branding guidelines](https://developers.google.com/identity/branding-guidelines)**.
- Dismiss: `colors.dim`, `typo.body` weight 600, no chrome, `space[3]` padding.

Motion (per KB §Restraint over decoration):
- Sheet entrance: `withTiming({ duration: 320, easing: easeStandard })` slide-up + fade.
- Sheet exit: same in reverse.
- Button press: existing `PressableScale` component.
- No shimmer, no glow, no breathing — matches the rest of the home page.

### 5c. Trigger placement: post-placement + settings

#### Post-placement trigger

In `app/index.tsx`, after `useUserProfile` resolves, watch for the
transition `roundsPlayed === PLACEMENT_TOTAL_ROUNDS - 1 → PLACEMENT_TOTAL_ROUNDS`.
This fires exactly once when the user finishes their 5th ranked round
of all time. Surface the link sheet after the placement-completion
ceremony (T1.3, currently deferred — for now, surface immediately on
home open if `roundsPlayed === PLACEMENT_TOTAL_ROUNDS && !isLinked`).

Gate the auto-prompt on a one-time-per-day persisted flag
(`AsyncStorage.getItem('account-link-last-prompt')`) so users who
dismiss aren't re-nagged on every app open.

#### Settings trigger

Replace the current home footer "reset progress" affordance with a
two-row layout when the user is anonymous:

```
                  save your progress            ← primary, accent color
              keep your rating across devices

                  reset progress                ← secondary, dim
            permanently deletes account & all data
```

When the user IS linked (post-link), revert to single-row "reset
progress" only — no need to upsell what they already have. Add a
small Apple/Google logo to the identity card name row to indicate
linked state ("✓ signed in with Apple" subtitle on first scroll,
fade after 5s).

### 5d. Update `lib/account.ts`

Linked users invoke `auth().signOut()` (recoverable) by default, with
a separate "permanently delete" path. Anonymous users keep current
behavior (delete is the only meaningful option).

```ts
import { isCurrentUserLinked } from './authLink';

export async function signOutCurrentUser(): Promise<void> {
  // For linked users only. Clears local session; user can sign back in
  // via the same provider to recover their uid + all data.
  await auth().signOut();
}

// `deleteCurrentAccount` semantics unchanged but the home screen UX
// now offers it as a separate destructive action for linked users
// (vs the only action for anonymous users).
```

Home screen handler logic:

```
if (isLinked) {
  // Two affordances in the footer:
  //  (1) "sign out" (text button, colors.dim) — recoverable
  //  (2) "permanently delete account" (text button, colors.danger small) — destructive
} else {
  // Single affordance, current "reset progress" wording.
}
```

### 5e. Boot wiring

In `lib/auth.tsx → AuthProvider`, call `configureGoogleSignIn(WEB_CLIENT_ID)`
once on mount before any sign-in attempts. Read `WEB_CLIENT_ID` from
`expo-constants` (set via `app.json → extra → googleWebClientId`) so the
secret isn't hardcoded.

---

## 6. Edge cases + error handling

| Scenario | Behavior |
|---|---|
| User cancels the Apple sheet | Show transient toast: "sign-in cancelled". Sheet stays open. |
| User cancels the Google sheet | Same. |
| `auth/credential-already-in-use` (this Apple/Google ID is linked to a different uid) | Sheet shows: "This account already exists. Sign in to switch — your current progress will be lost." Two buttons: "switch (lose current progress)" + "cancel". On switch, sign out + sign in via provider directly (NOT linkWithCredential), accept that the current anon uid's data is abandoned per Firebase canon (one-way upgrade). |
| Network failure mid-link | Toast: "couldn't connect, try again". Anon uid remains intact (linkWithCredential is atomic). |
| User links Apple, then on a new device opens the app and immediately taps Sign in with Apple from the link sheet | Native flow: same Apple ID → Firebase signs them into the existing uid. Their data is restored. (Note: this means the new device's anon uid is abandoned. Acceptable — they hadn't earned anything yet.) |
| Linked user taps "Sign Out" → reopens app | `signInAnonymously` runs, NEW anon uid is created. The home shows the link sheet automatically (since they have no progress). They tap "Continue with Apple" → signed back into their original uid. Data restored. |
| Apple/Google provider not enabled in Firebase Console | linkWithCredential throws `auth/operation-not-allowed`. Surface a generic "sign-in unavailable, try again later" — don't leak the misconfig. Log to console for dev. |

---

## 7. Analytics events to instrument

| Event | When | Properties |
|---|---|---|
| `link_sheet_shown` | Sheet appears | `trigger`: `post_placement` \| `settings` \| `manual` |
| `link_sheet_dismissed` | User taps "not now" or swipes down | `trigger`, `time_open_ms` |
| `link_attempted` | User taps Apple/Google button | `provider`: `apple` \| `google` |
| `link_success` | linkWithCredential resolves | `provider`, `prev_rounds_played`, `prev_elo` |
| `link_failure` | linkWithCredential rejects | `provider`, `error_code` |
| `sign_out` | Linked user signs out | (none) |
| `account_deleted` | Linked or anon user calls deleteAccount | `was_linked`, `provider` |

---

## 8. Acceptance criteria

The feature is shippable when ALL of these are true:

- [ ] Sign in with Apple link works end-to-end on a real iOS device.
- [ ] Sign in with Google link works end-to-end on a real Android device.
- [ ] Linking preserves the uid (verify ratingElo, roundsPlayed, etc.
      remain after link).
- [ ] Linked user can sign out → reinstall → sign back in → all data
      restored.
- [ ] Sheet auto-prompts exactly once per day after placement
      completion (cooldown via AsyncStorage).
- [ ] Sheet does NOT prompt on first launch (Firebase canon — anon-first).
- [ ] Settings footer shows "save your progress" CTA when anonymous,
      hides it when linked.
- [ ] Identity card shows a "linked" badge for linked users.
- [ ] "Reset progress" is renamed appropriately for linked users
      ("Sign out" + separate "Permanently delete account").
- [ ] Apple App Review test build passes — no rejection for missing
      Sign in with Apple alternative (Google sign-in alone would
      trigger 5.1.1(c); Apple satisfies it).
- [ ] All seven analytics events fire correctly.

---

## 9. Citations

- Firebase blog — Best Practices for Anonymous Authentication: <https://firebase.blog/posts/2023/07/best-practices-for-anonymous-authentication>
- Firebase Auth — Account linking: <https://firebase.google.com/docs/auth/web/account-linking>
- Apple Developer — Sign in with Apple: <https://developer.apple.com/sign-in-with-apple/>
- Apple App Review 5.1.1(c) — alternative login requirement: <https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage>
- 9to5Mac on the 2024 SiwA clarification: <https://9to5mac.com/2024/01/27/sign-in-with-apple-rules-app-store/>
- Google for Developers — Sign in with Google: <https://developers.google.com/identity/sign-in/web/sign-in>
- Google for Developers — Branding guidelines: <https://developers.google.com/identity/branding-guidelines>
- Android Developers Blog — Migrating users to passkeys: <https://developer.android.com/blog/posts/best-practices-for-migrating-users-to-passkeys-with-credential-manager>
- `@invertase/react-native-apple-authentication`: <https://github.com/invertase/react-native-apple-authentication>
- `@react-native-google-signin/google-signin`: <https://github.com/react-native-google-signin/google-signin>
- ux-design-expert KB §"Anonymous-auth: Sign Out is a misleading affordance" (2026-05-10)
- ux-design-expert KB §"Apple App Store account-deletion policy (5.1.1(v))" (2026-05-10)

---

## 10. Open questions for future-you

- Should we offer Sign in with Apple on Android? Apple supports it via
  web fallback, and some users have only an Apple ID. Adds complexity
  for a small cohort; defer until evidence of need.
- Should the link sheet remember which provider the user used last so
  the next sign-in defaults to it? (Yes — but as a polish iteration,
  not v1.)
- Should we add a "transfer my progress to a friend's account" flow?
  (No — explicitly disallowed by Firebase canon. Linking is one-way.)
