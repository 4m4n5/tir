import { createContext, useContext, useEffect, useState } from 'react';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

type AuthState = { userId: string | null; loading: boolean; ready: boolean };

const AuthContext = createContext<AuthState>({
  userId: null,
  loading: true,
  ready: false,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    userId: null,
    loading: true,
    ready: false,
  });

  useEffect(() => {
    const unsubscribe = auth().onAuthStateChanged(user => {
      if (user) {
        setState({ userId: user.uid, loading: false, ready: true });
      } else {
        // Hard reset on sign-out (including the post-`deleteAccount`
        // path). Earlier this branch did `setState(prev => ({ ...prev,
        // loading: false }))`, which preserved `prev.userId` AND
        // `prev.ready: true`. That was a silent corruption: after
        // reset-progress the cached state still pointed at the now-
        // deleted uid, the `signInAnonymously` effect below early-
        // returned (because `state.userId` was truthy), and the next
        // /name save fired against `users/{deletedUid}` with no
        // signed-in user -> firestore/permission-denied. Always
        // collapse to a clean unauthenticated state so the
        // signInAnonymously effect re-fires and produces a fresh uid.
        setState({ userId: null, loading: false, ready: false });
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (state.loading || state.userId) return;
    auth()
      .signInAnonymously()
      .catch(() => {});
  }, [state.loading, state.userId]);

  return (
    <AuthContext.Provider value={state}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

export type UserProfile = {
  displayName?: string;
  avatarEmoji?: string;
  ratingElo: number;
  roundsPlayed: number;
  roundsWon: number;
  winStreak: number;
  roundsPhotoFinish: number;
  dailyStreak?: number;
  firstWinAt?: string;
  // winsToday — server-incremented on every win; resets to 1 on the
  // first win of a new UTC day. Client must gate display on
  // `firstWinAt === todayKey` because the field is NOT cleared at
  // midnight (it's only updated when the user wins again the next
  // day). Drives the home-screen avatar glow intensity ramp.
  winsToday?: number;
  lastRoundDelta?: number;
  // Server timestamp of when the player finished (or skipped) the
  // /welcome onboarding tutorial. Persisted on the user doc rather
  // than AsyncStorage so a fresh anon session after `Reset progress`
  // correctly re-shows the tutorial — that user is a NEW player and
  // deserves orientation. NavigationGate keys off truthiness.
  tutorialCompletedAt?: string;
};

export function useUserProfile(userId: string | null) {
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    if (!userId) {
      setProfile(null);
      return;
    }
    // Second `onSnapshot` arg is the error callback. Required because
    // during the account-delete flow, the auth context flips while this
    // listener is still attached to the old uid's doc — the next
    // snapshot attempt errors with `permission-denied` and (without an
    // error handler) bubbles as an unhandled promise rejection that
    // can crash the app on iOS. Treating any listener error as
    // "profile gone" is the right behaviour: it forces a re-render
    // with `profile=null`, which lets `NavigationGate` route
    // appropriately on the next userId update.
    return firestore()
      .doc(`users/${userId}`)
      .onSnapshot(
        snap => {
          const d = snap.data();
          setProfile({
            displayName: d?.displayName as string | undefined,
            avatarEmoji: d?.avatarEmoji as string | undefined,
            ratingElo: Number(d?.ratingElo ?? 1000),
            roundsPlayed: Number(d?.roundsPlayed ?? 0),
            roundsWon: Number(d?.roundsWon ?? 0),
            winStreak: Number(d?.winStreak ?? 0),
            roundsPhotoFinish: Number(d?.roundsPhotoFinish ?? 0),
            dailyStreak: d?.dailyStreak != null ? Number(d.dailyStreak) : undefined,
            firstWinAt: d?.firstWinAt as string | undefined,
            winsToday: d?.winsToday != null ? Number(d.winsToday) : undefined,
            lastRoundDelta: d?.lastRoundDelta != null ? Number(d.lastRoundDelta) : undefined,
            // Stored as a Firestore Timestamp; we only use it for
            // truthiness in NavigationGate, so coerce to ISO string.
            tutorialCompletedAt: d?.tutorialCompletedAt
              ? (d.tutorialCompletedAt.toDate?.()?.toISOString() ?? String(d.tutorialCompletedAt))
              : undefined,
          });
        },
        err => {
          // Permission-denied is expected during account-delete and
          // sign-out transitions; not noteworthy. Other errors (network,
          // etc.) get a console warn for debugging but otherwise behave
          // the same — null profile, let the next state change recover.
          if ((err as { code?: string })?.code !== 'firestore/permission-denied') {
            console.warn('useUserProfile listener error:', err);
          }
          setProfile(null);
        },
      );
  }, [userId]);

  return profile;
}
