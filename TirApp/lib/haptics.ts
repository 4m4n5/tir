import * as Haptics from 'expo-haptics';

// DESIGN.md §7 — haptic vocabulary
// Every haptic call goes through this module. No inline Haptics.* in features.

export function chipSelect() {
  // Apple HIG (https://developer.apple.com/documentation/applepencil/playing-haptic-feedback-in-your-app):
  // - selectionAsync = incremental value changes (pickers, sliders, segmented controls)
  // - impactAsync(Light/Medium/Heavy) = button presses and meaningful UI interactions
  //
  // The option chip is the marquee mechanic of the game — a button
  // press, not a value change. Switched from selectionAsync (the
  // lightest possible iOS haptic, used for picker wheels) to
  // impactAsync(Light) on 2026-05-10. Light, not Medium, because the
  // chip can fire up to ~25 times per round; a Medium would compound
  // into noise. Light gives the press substance without becoming
  // intrusive.
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

export function targetReached() {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

export function photoFinish() {
  setTimeout(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, 80);
}

export function finishWindowStart() {
  Haptics.selectionAsync();
}

export function leagueCrossed() {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

export function snapBonus() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
}

export function errorFeedback() {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
}
