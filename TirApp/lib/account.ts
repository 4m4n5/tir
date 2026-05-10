import auth from '@react-native-firebase/auth';
import { callDeleteAccount } from '../src/rooms/privateRooms';

// ---------------------------------------------------------------------------
// Account lifecycle for the current (anonymous) Firebase Auth user.
//
// Apple App Store Review Guideline 5.1.1(v) requires that apps which
// auto-create accounts (including anonymous / "guest" accounts) provide
// an in-app account deletion flow. See:
//   https://developer.apple.com/support/offering-account-deletion-in-your-app
//   ("My app automatically creates an account for the user. Do I need to
//    include an option to initiate account deletion? Yes.")
//
// `tir` is currently anonymous-auth-only: there is no Sign in with Apple /
// Google / email path. So in this codebase, "sign out" and "delete
// account" are functionally identical — both wipe the user's progress
// because re-anonymous-sign-in produces a brand new uid. We therefore
// expose only `deleteCurrentAccount`, with friendly "reset progress"
// framing on the surface. When account-link arrives later, add a real
// `signOut()` here and re-introduce a separate Sign Out affordance.
// ---------------------------------------------------------------------------

// Deletes all data associated with the current user and removes their
// Firebase Auth record. After this resolves, `AuthProvider`'s
// `onAuthStateChanged` listener will fire with a null user and
// `signInAnonymously()` again, giving the player a fresh anonymous
// identity with zero progress. `NavigationGate` will route the new
// (display-name-less) user to `/name` automatically.
//
// History (2026-05-10):
//   v1: Client-side approach — `firestore().doc('users/{uid}').delete()`
//       + `firestore().doc('publicProfiles/{uid}').delete()` + `user.delete()`.
//       CRASHED in production: firestore.rules disallows client deletes
//       on `users/{userId}` (no `allow delete` clause) AND disallows ALL
//       client writes to `publicProfiles/{userId}` (`allow write: if
//       false`). Both Firestore deletes failed silently inside
//       `Promise.allSettled`, then `auth.delete()` succeeded — leaving
//       orphan Firestore docs and a torn-down auth context that crashed
//       the home-screen listeners (useUserProfile, useLeaderboard,
//       useMyGlobalRank) on the next snapshot. Replaced with v2.
//   v2 (this version): Server-side `deleteAccount` callable does the
//       full delete via the admin SDK (bypasses rules), then the client
//       calls `auth().signOut()` locally to flip onAuthStateChanged
//       immediately and trigger re-anon-sign-in.
//
// What happens server-side (see functions/src/callables.ts → deleteAccount):
//   - `users/{uid}`            deleted
//   - `publicProfiles/{uid}`   deleted (also re-deleted by the
//     `syncPublicProfile` Firestore trigger — idempotent)
//   - `rooms/{*}/players/{uid}` deleted for every room the user was in
//     (so other players' rosters drop them immediately, no ghosts)
//   - Firebase Auth user record deleted
//
// What does NOT get deleted (intentional, see App Review FAQ):
//   - `memberIds` arrays on rooms still containing the deleted uid —
//     heartbeat reaper handles eventual cleanup.
//   - Past `rounds/{seq}.results.deltas.{uid}` blobs — event/log
//     data convention, not UGC.
export async function deleteCurrentAccount(): Promise<void> {
  // 1. Server-side delete. This deletes the auth user too, but the
  // local SDK doesn't immediately know — it still has a stale
  // `currentUser` until it refreshes the token (next request) or we
  // sign out explicitly.
  await callDeleteAccount();

  // 2. Force the local session to clear so `onAuthStateChanged` fires
  // immediately. Without this step, the home screen continues to render
  // bound to the now-deleted uid until the auth SDK detects the token
  // is invalid (potentially seconds later, racing with active Firestore
  // listeners that will start erroring out as soon as a new query is
  // attempted). Forcing signOut here guarantees a clean transition:
  //   onAuthStateChanged(null) → AuthProvider sets userId=null
  //   → useEffect calls signInAnonymously()
  //   → onAuthStateChanged(newUid) → AuthProvider sets userId=newUid
  //   → NavigationGate sees no displayName → router.replace('/name')
  // Wrap in try/catch — if the auth user is already gone, signOut may
  // throw `auth/no-current-user`. That's the success state, not an
  // error.
  try {
    await auth().signOut();
  } catch {
    // No current user — already in the clean post-delete state.
  }
}
