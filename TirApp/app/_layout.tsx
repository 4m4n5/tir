import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Stack, router, useSegments } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth, useUserProfile } from '../lib/auth';
import { colors } from '../lib/theme';

function NavigationGate({ children }: { children: React.ReactNode }) {
  const { userId, ready } = useAuth();
  const profile = useUserProfile(userId);
  const segments = useSegments();

  // Three-stage onboarding gate (Apple HIG §Onboarding "lead with
  // content"; NN/g `mobile-app-onboarding` "skip is sacred"):
  //   1. anon auth completes (handled by AuthProvider) → userId set
  //   2. no displayName        → /name        (capture identity)
  //   3. no tutorialCompletedAt → /welcome    (3-card "show, don't tell")
  //   4. otherwise              → /           (home)
  // The tutorial is a one-time gate per anon-user. Resetting progress
  // (deleteAccount Cloud Function) wipes the user doc, so a fresh anon
  // session correctly re-shows the tutorial — the new uid IS a new
  // player. KB §Onboarding (yukaichou.com always-visible-action-rule).
  useEffect(() => {
    if (!ready || !userId) return;
    if (profile === null) return;

    const root = segments[0];
    const onNameScreen = root === 'name';
    const onWelcomeScreen = root === 'welcome';
    const hasName = !!profile?.displayName;
    const hasFinishedTutorial = !!profile?.tutorialCompletedAt;

    if (!hasName) {
      if (!onNameScreen) router.replace('/name');
      return;
    }
    if (!hasFinishedTutorial) {
      if (!onWelcomeScreen) router.replace('/welcome');
      return;
    }
    if (onNameScreen || onWelcomeScreen) {
      router.replace('/');
    }
  }, [ready, userId, profile, segments]);

  return <>{children}</>;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <StatusBar style="light" />
          <NavigationGate>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bg },
                animation: 'fade',
              }}
            />
          </NavigationGate>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
