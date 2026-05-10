import * as admin from 'firebase-admin';
import {onDocumentWritten} from 'firebase-functions/v2/firestore';

const REGION = 'us-central1';

export const syncPublicProfile = onDocumentWritten(
  {document: 'users/{userId}', region: REGION},
  async event => {
    const userId = event.params.userId;
    const after = event.data?.after?.data();

    if (!after) {
      await admin.firestore().doc(`publicProfiles/${userId}`).delete();
      return;
    }

    await admin.firestore().doc(`publicProfiles/${userId}`).set({
      displayName: after.displayName ?? null,
      avatarEmoji: after.avatarEmoji ?? null,
      ratingElo: after.ratingElo ?? 1000,
      league: leagueFromElo(after.ratingElo ?? 1000),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  },
);

// Keep in sync with TirApp/src/rooms/privateRooms.ts → LEAGUES.
// 8-tier ladder. Bands are 200 Elo wide; Stone (floor) and Grandmaster
// (head) are open-ended. Returned name is the lowercase tier key — the
// client renders the icon by re-deriving the tier from ratingElo, so the
// only consumer of this string is the `league` field on publicProfiles
// (used for filtering / debug dashboards, not for badge rendering).
function leagueFromElo(elo: number): string {
  if (elo >= 2100) return 'grandmaster';
  if (elo >= 1900) return 'master';
  if (elo >= 1700) return 'diamond';
  if (elo >= 1500) return 'platinum';
  if (elo >= 1300) return 'gold';
  if (elo >= 1100) return 'silver';
  if (elo >= 900) return 'bronze';
  return 'stone';
}
