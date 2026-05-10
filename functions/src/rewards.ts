import * as admin from 'firebase-admin';

const db = () => admin.firestore();

// ===========================================================================
// Rating progression — V3 (2026-05-10): pure pairwise Elo.
//
// History:
//   V1: K=32 against table mean + flat additive bonuses (speed/snap/streak/
//       underdog). Bonuses dominated math at high rating differentials,
//       photo-finishers always gained ≥+1 (inflationary), masters
//       whiplashed with K=32, system was net-positive (Elo creeped up).
//   V2: V1 with constraint-driven additions: WIN_FLOOR / LOSS_CAP /
//       PHOTO_FLOOR / underdog damping / first-round-of-session grace /
//       dynamic K (rating × experience tiers). Added complexity for
//       softer player experience but moved away from "pure Elo".
//   V3 (this file): Strip everything back to pure pairwise Elo. No
//       floors, no caps, no damping, no grace, no K tiers. The Elo math
//       is the entire scoring model — trust it.
//
// V3 design philosophy: keep the rating math mathematically clean and
// move ALL engagement / reward / loss-protection concerns OUT of the Elo
// math and INTO orthogonal systems (placement-period UX, daily quests,
// streak celebrations, weekly snapshot leaderboards, tier-promotion
// ceremonies, match history, etc). Elo measures skill; engagement is a
// separate concern. Mixing the two corrupts both.
//
// The math:
//   For each player P in a round of N players:
//     baseDelta_P = K × Σ over opponents O of (actual_PO - expected_PO)
//   where:
//     actual_PO   = 1.0  if P beat O   (strictly earlier finish)
//                   0.5  if P tied O   (same rank — both in finish window)
//                   0.0  if O beat P
//     expected_PO = 1 / (1 + 10^((elo_O - elo_P) / 400))
//   That's it. Round to integer. Clamp at ELO_FLOOR (sanity guard
//   matching FIDE's "no negative absolute rating" convention).
//
// Rank tiers per round (used to derive `actual` in the pairwise sum):
//   0 = primary winner       (strict first finisher)
//   1 = photo-finisher       (finished within the 3s finish window)
//   2 = loser                (didn't reach target)
// Two players at the same rank tie (actual = 0.5 for that pair).
//
// Solo rounds (N=1, the player is alone in the global pool):
//   Pairwise math has nothing to compare against, so the player would
//   otherwise get zero. That reads as broken — common at off-peak hours
//   and on launch day. We award a positive Elo signal but with
//   per-day diminishing returns + a +1 floor, so solo can't be farmed
//   into a viable ladder-climb path:
//
//     Solo win N today → delta = max(1, round(8 × 0.5^(N-1)))
//
//     N=1: +8        N=4: +1
//     N=2: +4        N=5+: +1 (floor)
//     N=3: +2
//
//   Cumulative cap is implicit: ~+15 from the first 4 wins, then a flat
//   +1 per subsequent solo win (~+60 Elo/hour at 60 rounds/hour). At
//   that rate a pure-solo grinder takes ≥18 wall-hours to climb from
//   Stone to Master, by which time matchmaking against real opponents
//   would deflate them fast. Acceptable inflation — explicit product
//   choice (the "showing up always gets at least +1" semantic is more
//   important than perfect zero-sum integrity). Riot Co-op-vs-AI XP
//   diminishing canon, with a never-zero floor.
//
//   Storage: `users.{soloWinsToday, firstSoloWinAt}` mirrors the
//   `winsToday / firstWinAt` pattern. firstSoloWinAt gates the counter
//   for stale-day detection; commit resets to 1 on the first solo
//   win of a new UTC day, increments otherwise.
//
//   Photo-finish and loss outcomes are impossible in solo (round
//   doesn't finalize until the single player wins), so the solo
//   branch is win-only by construction.
//
//   All values integer by design — `round(8 × 0.5^N)` for N=0..3 is
//   already integral; N≥4 is forced to 1 by the floor.
//
// Consequences (intentional, not bugs):
// - A Master who wins a Stone-tier table gains ≈+0 to +1 Elo. The win
//   was expected; pure Elo math says you barely earned anything. This
//   is how chess Elo behaves and is the price of purity.
// - A Stone who beats a Master-tier table gains a LOT (~K × N-1).
// - A Master who loses to a Stone-tier table loses a LOT. Elo is brutal
//   for heavily favored players who lose.
// - The system is approximately zero-sum per round in multi-player
//   tables (sum of all deltas ≈ 0). Solo rounds are NOT zero-sum
//   (+8/round into the system); see solo-round notes above.
// - First-round-of-session players get no special treatment — if they
//   lose, they lose Elo. Onboarding / loss-aversion concerns must be
//   addressed via UX (e.g. hide numerical Elo for first 5 placement
//   rounds, show "Calibrating N/5" instead).
// ===========================================================================

const K = 16;             // single global K-factor.
const ELO_FLOOR = 100;    // absolute floor; rating never goes below.
const DEFAULT_NEW_PLAYER_ELO = 1000;

function expectedScore(myElo: number, oppElo: number): number {
  return 1 / (1 + Math.pow(10, (oppElo - myElo) / 400));
}

function clampElo(elo: number): number {
  return Math.max(ELO_FLOOR, Math.round(elo));
}

export type RoundDeltaRow = {
  uid: string;
  delta: number;
  newElo: number;
  outcome: 'win' | 'photo' | 'loss';
  // Bookkeeping — `commitRoundDeltas` reads these instead of re-fetching
  // user docs.
  prevElo: number;
  prevWinStreak: number;
  newWinStreak: number;
  prevLastPlayedDay: string;
  prevDailyStreak: number;
  prevFirstWinAt: string;
  prevRoundsPlayed: number;
  // Solo-round bookkeeping. Set on EVERY row regardless of solo-ness so
  // commit can read uniformly; `wasSolo` toggles whether commit
  // increments the daily counter. Solo gain decays per-day with a +1
  // floor — see compute logic below.
  wasSolo: boolean;
  prevSoloWinsToday: number;
  prevFirstSoloWinAt: string;
};

export type RoundDeltasResult = {
  rows: RoundDeltaRow[];
  // Convenience map for callers that just want {uid → delta} (e.g.
  // to embed in the round.results blob).
  deltaMap: Record<string, number>;
  // Per-uid post-this-round count of completed rounds (= prev + 1).
  // Embedded in round.results so the popup can render the placement
  // banner ("Calibrating N/5") on its very first frame instead of
  // flickering between the Elo numeral and the banner when the user
  // doc listener catches up ~200ms later.
  roundsAfterMap: Record<string, number>;
};

// Pure compute step. Reads user docs, computes per-player Elo deltas,
// returns the full picture WITHOUT writing anything. Pair with
// `commitRoundDeltas` to apply.
//
// Splitting compute from commit lets callers stash the deltas in the
// same CAS that flips `phase=results`, so the popup reads correct
// numbers the instant it appears (no "0 → real value" jitter).
//
// `winnerMoves` and `winnerSnap` are kept in the signature for backwards
// compatibility with `applyRoundRewards`. They no longer affect the Elo
// math (V3 dropped all bonuses); kept for cosmetic-UI signals.
export async function computeRoundDeltas(args: {
  primaryWinnerUid: string | null;
  windowFinisherUids: string[];
  allPlayerUids: string[];
  winnerMoves?: number | null;
  winnerSnap?: boolean;
}): Promise<RoundDeltasResult> {
  const {primaryWinnerUid, windowFinisherUids, allPlayerUids} = args;
  // Empty round → nothing to do. (Solo rounds, N=1, are handled below
  // via a ghost-opponent at the player's own Elo — see file header.)
  if (allPlayerUids.length < 1) {
    return {rows: [], deltaMap: {}, roundsAfterMap: {}};
  }

  // Hydrate snapshots in one read.
  const userRefs = allPlayerUids.map(uid => db().collection('users').doc(uid));
  const userSnaps = await db().getAll(...userRefs);

  type Snapshot = {
    elo: number;
    winStreak: number;
    lastPlayedDay: string;
    dailyStreak: number;
    firstWinAt: string;
    roundsPlayed: number;
    // Solo decay state. `firstSoloWinAt` is the day-key of the player's
    // first solo win in their current "solo day". When it doesn't equal
    // today's dayKey, the soloWinsToday counter is treated as 0 (stale
    // day). Mirrors the firstWinAt / winsToday pattern.
    soloWinsToday: number;
    firstSoloWinAt: string;
  };
  const dayKey = new Date().toISOString().slice(0, 10);
  const snap = new Map<string, Snapshot>();
  for (let i = 0; i < allPlayerUids.length; i++) {
    const uid = allPlayerUids[i];
    const data = userSnaps[i]?.data();
    snap.set(uid, {
      elo: Number(data?.ratingElo ?? DEFAULT_NEW_PLAYER_ELO),
      winStreak: Number(data?.winStreak ?? 0),
      lastPlayedDay: String(data?.lastPlayedDay ?? ''),
      dailyStreak: Number(data?.dailyStreak ?? 0),
      firstWinAt: String(data?.firstWinAt ?? ''),
      roundsPlayed: Number(data?.roundsPlayed ?? 0),
      soloWinsToday: Number(data?.soloWinsToday ?? 0),
      firstSoloWinAt: String(data?.firstSoloWinAt ?? ''),
    });
  }

  // Rank by finish: 0 = winner, 1 = photo-finisher (tied), 2 = loser
  // (tied). Lower-rank beats higher-rank → actual = 1.0; same rank →
  // actual = 0.5; higher-rank → actual = 0.0.
  const rankOf = new Map<string, 0 | 1 | 2>();
  for (const uid of allPlayerUids) rankOf.set(uid, 2);
  for (const uid of windowFinisherUids) {
    if (allPlayerUids.includes(uid)) rankOf.set(uid, 1);
  }
  if (primaryWinnerUid && allPlayerUids.includes(primaryWinnerUid)) {
    rankOf.set(primaryWinnerUid, 0);
  }

  const rows: RoundDeltaRow[] = [];
  for (const uid of allPlayerUids) {
    const me = snap.get(uid);
    if (!me) continue;
    const myRank = rankOf.get(uid) ?? 2;

    let outcome: RoundDeltaRow['outcome'];
    if (myRank === 0) outcome = 'win';
    else if (myRank === 1) outcome = 'photo';
    else outcome = 'loss';

    // Pure pairwise Elo. No floors. No caps. No damping. No K-decay.
    let pairwiseSum = 0;
    let opponentCount = 0;
    for (const oppUid of allPlayerUids) {
      if (oppUid === uid) continue;
      const opp = snap.get(oppUid);
      if (!opp) continue;
      opponentCount++;
      const oppRank = rankOf.get(oppUid) ?? 2;
      let actual: number;
      if (myRank < oppRank) actual = 1.0;
      else if (myRank > oppRank) actual = 0.0;
      else actual = 0.5;
      pairwiseSum += actual - expectedScore(me.elo, opp.elo);
    }
    // Solo round → diminishing-returns curve with a +1 floor so solo
    // can't be farmed into the ladder (see file header for the math
    // and the rationale). Bypasses the Elo formula entirely; the solo
    // delta is computed directly. By construction the lone player is
    // the primary winner (rank 0; the round only finalizes when
    // target is reached, no loss path exists in solo). Defensive
    // `myRank === 0` guard so any future code path that finalizes a
    // solo round non-winningly doesn't accidentally inflate.
    const wasSolo = opponentCount === 0;
    let delta: number;
    if (wasSolo && myRank === 0) {
      // Stale-day gate: if firstSoloWinAt is not today, the counter
      // resets — this is the player's 1st solo win of a new UTC day.
      const soloWinsBefore =
        me.firstSoloWinAt === dayKey ? me.soloWinsToday : 0;
      const N = soloWinsBefore + 1; // 1-indexed: this is the Nth solo today
      const decayed = Math.round(8 * Math.pow(0.5, N - 1));
      delta = Math.max(1, decayed);
    } else {
      delta = Math.round(K * pairwiseSum);
    }
    const newElo = clampElo(me.elo + delta);
    const newWinStreak = outcome === 'win' ? me.winStreak + 1 : 0;

    rows.push({
      uid,
      delta,
      newElo,
      outcome,
      prevElo: me.elo,
      prevWinStreak: me.winStreak,
      newWinStreak,
      prevLastPlayedDay: me.lastPlayedDay,
      prevDailyStreak: me.dailyStreak,
      prevFirstWinAt: me.firstWinAt,
      prevRoundsPlayed: me.roundsPlayed,
      wasSolo,
      prevSoloWinsToday: me.soloWinsToday,
      prevFirstSoloWinAt: me.firstSoloWinAt,
    });
  }

  const deltaMap: Record<string, number> = {};
  const roundsAfterMap: Record<string, number> = {};
  for (const r of rows) {
    deltaMap[r.uid] = r.delta;
    // After this round commits, roundsPlayed increments by 1. The
    // popup needs the post-round value to decide whether to render
    // the placement banner.
    roundsAfterMap[r.uid] = r.prevRoundsPlayed + 1;
  }
  return {rows, deltaMap, roundsAfterMap};
}

// Commit step (unchanged). Idempotent via `rewardLocks/{roomId}_{roundSeq}`
// — first caller wins the lock and writes everything in one batch;
// subsequent callers no-op.
//
// PRIVATE ROOMS ARE PRACTICE ONLY: when the room's `mode` is `private`,
// this function takes the lock (so duplicate callers no-op cleanly) but
// writes NOTHING to user docs, player docs, or analytics. Elo, win
// streaks, daily streaks, first-win-today, rounds-played — none of it
// advances. Private rooms are explicitly the practice / friends sandbox;
// the ranking system is reserved for the global pool.
export async function commitRoundDeltas(args: {
  roomId: string;
  roundSeq: number;
  rows: RoundDeltaRow[];
}): Promise<void> {
  const {roomId, roundSeq, rows} = args;
  if (!rows.length) return;
  const dayKey = new Date().toISOString().slice(0, 10);

  const lockRef = db().collection('rewardLocks').doc(`${roomId}_${roundSeq}`);
  try {
    await lockRef.create({
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch {
    return;
  }

  // Resolve room mode once — gate ALL ranked-state writes on it.
  const roomSnap = await db().collection('rooms').doc(roomId).get();
  const roomMode = String(roomSnap.data()?.mode ?? 'private');
  if (roomMode !== 'global') {
    // Practice / friends room: no Elo, no streaks, no analytics.
    // The lock is held so duplicate callers no-op cleanly.
    return;
  }

  const playerRef = (uid: string) =>
    db().collection('rooms').doc(roomId).collection('players').doc(uid);

  const batch = db().batch();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  for (const row of rows) {
    const userRef = db().collection('users').doc(row.uid);
    const userPatch: Record<string, unknown> = {
      ratingElo: row.newElo,
      lastPlayedDay: dayKey,
      roundsPlayed: admin.firestore.FieldValue.increment(1),
      lastRoundDelta: row.delta,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (row.outcome === 'win') {
      userPatch.winStreak = row.newWinStreak;
      userPatch.roundsWon = admin.firestore.FieldValue.increment(1);
      if (row.prevLastPlayedDay === yesterday) {
        userPatch.dailyStreak = row.prevDailyStreak + 1;
      } else if (row.prevLastPlayedDay !== dayKey) {
        userPatch.dailyStreak = 1;
      }
      // winsToday — drives the home-screen avatar glow ramp. Reset
      // semantics: on the first win of a new UTC day (prevFirstWinAt
      // is empty OR a previous day's key), set to 1; otherwise atomic
      // increment so concurrent wins (rare but possible) compose
      // correctly. Pair with `firstWinAt` so the client can detect
      // stale counters (user lost yesterday → winsToday is yesterday's
      // value but firstWinAt is yesterday's key, gate on equality).
      if (row.prevFirstWinAt !== dayKey) {
        userPatch.firstWinAt = dayKey;
        userPatch.winsToday = 1;
      } else {
        userPatch.winsToday = admin.firestore.FieldValue.increment(1);
      }
      // Solo-decay counter — tick only for solo wins. Same reset
      // semantics as winsToday: stale day → reset to 1; same day →
      // atomic increment. Drives the diminishing-returns curve in
      // computeRoundDeltas (see file header). Multiplayer wins do
      // NOT touch this counter; the next solo win after a multiplayer
      // session continues from where the player left off in the day.
      if (row.wasSolo) {
        if (row.prevFirstSoloWinAt !== dayKey) {
          userPatch.firstSoloWinAt = dayKey;
          userPatch.soloWinsToday = 1;
        } else {
          userPatch.soloWinsToday = admin.firestore.FieldValue.increment(1);
        }
      }
    } else if (row.outcome === 'photo') {
      userPatch.winStreak = 0;
      userPatch.roundsPhotoFinish = admin.firestore.FieldValue.increment(1);
    } else {
      userPatch.winStreak = 0;
    }
    batch.set(userRef, userPatch, {merge: true});
    batch.set(
      playerRef(row.uid),
      {
        lastRoundDelta: row.delta,
        // Tag the delta with the round seq it belongs to. The client
        // refuses to display lastRoundDelta as the popup's elo number
        // unless this seq matches the results blob's `completedSeq` —
        // prevents the previous round's delta from briefly flashing on
        // the popup if `r.deltas[uid]` is missing for any reason
        // (e.g. user was pruned from `memberIds` by the ghost path).
        lastRoundDeltaSeq: roundSeq,
        eloAtRoundEnd: row.newElo,
      },
      {merge: true},
    );
  }

  const agg = db().collection('analytics').doc(dayKey);
  batch.set(
    agg,
    {
      roundCompletions: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    {merge: true},
  );

  await batch.commit();
}

// Backwards-compatible facade — does the full compute+commit. Kept so
// fallback paths and tests don't change. New callers should prefer
// `computeRoundDeltas` + `commitRoundDeltas` so the deltas can be
// embedded in the same CAS that flips `phase=results`.
export async function applyRoundRewards(args: {
  roomId: string;
  roundSeq: number;
  primaryWinnerUid: string | null;
  windowFinisherUids: string[];
  allPlayerUids: string[];
  winnerSnap?: boolean;
  winnerMoves?: number | null;
}): Promise<void> {
  const {rows} = await computeRoundDeltas({
    primaryWinnerUid: args.primaryWinnerUid,
    windowFinisherUids: args.windowFinisherUids,
    allPlayerUids: args.allPlayerUids,
    winnerSnap: args.winnerSnap,
    winnerMoves: args.winnerMoves ?? null,
  });
  await commitRoundDeltas({
    roomId: args.roomId,
    roundSeq: args.roundSeq,
    rows,
  });
}
