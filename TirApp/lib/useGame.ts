import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import firestore from '@react-native-firebase/firestore';
import {
  callAssignGlobalRoom,
  callCreatePrivateRoom,
  callFinalizeFinishWindow,
  callJoinPrivateRoom,
  callSubmitMove,
  logPerf,
  myPlayerDoc,
  playersCollection,
  roomDoc,
  roundDoc,
  type MyPlayerState,
  type RoundState,
} from '../src/rooms/privateRooms';

export type RosterEntry = { id: string; currentWord: string };

export function useGame(userId: string | null, initialRoomId?: string) {
  const [roomId, setRoomId] = useState<string | null>(initialRoomId ?? null);
  const [roomMode, setRoomMode] = useState<string | null>(null);
  const [round, setRound] = useState<RoundState | null>(null);
  const [myPlayer, setMyPlayer] = useState<MyPlayerState | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [finishCountdown, setFinishCountdown] = useState<number | null>(null);
  const [roundToast, setRoundToast] = useState<string | null>(null);
  const prevRoundSeq = useRef<number | null>(null);

  const rRound = useMemo(() => (roomId ? roundDoc(roomId) : null), [roomId]);
  const rPlayer = useMemo(
    () => (roomId && userId ? myPlayerDoc(roomId, userId) : null),
    [roomId, userId],
  );
  const rRoom = useMemo(() => (roomId ? roomDoc(roomId) : null), [roomId]);

  // Room mode listener
  useEffect(() => {
    if (!rRoom) { setRoomMode(null); return; }
    return rRoom.onSnapshot(snap => {
      const m = snap.data()?.mode;
      setRoomMode(typeof m === 'string' ? m : null);
    });
  }, [rRoom]);

  // Round listener
  useEffect(() => {
    if (!rRound) { setRound(null); return; }
    return rRound.onSnapshot(snap => {
      const d = snap.data() as Partial<RoundState> | undefined;
      if (!d?.targetWord) { setRound(null); return; }
      const rs: RoundState = {
        targetWord: String(d.targetWord),
        phase: (d.phase as RoundState['phase']) ?? 'active',
        phaseEndsAt: d.phaseEndsAt as RoundState['phaseEndsAt'],
        roundSeq: Number(d.roundSeq ?? 1),
        primaryWinnerUid: (d.primaryWinnerUid as string | null) ?? null,
        windowFinishers: (d.windowFinishers as string[]) ?? [],
      };
      const pr = prevRoundSeq.current;
      if (pr !== null && rs.roundSeq > pr) {
        setRoundToast(`new target — round ${rs.roundSeq}`);
        setTimeout(() => setRoundToast(null), 2200);
      }
      prevRoundSeq.current = rs.roundSeq;
      setRound(rs);
    });
  }, [rRound]);

  // Player listener
  useEffect(() => {
    if (!rPlayer) { setMyPlayer(null); return; }
    return rPlayer.onSnapshot(snap => {
      const d = snap.data() as Partial<MyPlayerState> | undefined;
      if (!d?.options || !d.currentWord) { setMyPlayer(null); return; }
      const opts = d.options as string[];
      if (opts.length !== 4) { setMyPlayer(null); return; }
      setMyPlayer({
        currentWord: String(d.currentWord),
        options: opts as [string, string, string, string],
        usedOptionWords: d.usedOptionWords as string[] | undefined,
      });
    });
  }, [rPlayer]);

  // Roster listener
  useEffect(() => {
    if (!roomId) { setRoster([]); return; }
    return playersCollection(roomId).onSnapshot(snap => {
      setRoster(
        snap.docs.map(doc => ({
          id: doc.id,
          currentWord: String(doc.data()?.currentWord ?? '—'),
        })),
      );
    });
  }, [roomId]);

  // Finish window countdown
  useEffect(() => {
    if (!roomId || !round || round.phase !== 'finish_window' || !round.phaseEndsAt) {
      setFinishCountdown(null);
      return;
    }
    const ends = round.phaseEndsAt.toMillis();
    const tick = () => {
      const left = Math.max(0, Math.ceil((ends - Date.now()) / 1000));
      setFinishCountdown(left);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [roomId, round]);

  const maybeFinalize = useCallback(async () => {
    if (!roomId) return;
    try {
      const t0 = Date.now();
      const res = await callFinalizeFinishWindow(roomId);
      logPerf('finalizeFinishWindow', t0);
      if (res.transitioned) setFinishCountdown(null);
    } catch { /* transient races */ }
  }, [roomId]);

  // Auto-finalize when window expires
  useEffect(() => {
    if (!roomId || !round || round.phase !== 'finish_window' || !round.phaseEndsAt) return;
    if (Date.now() < round.phaseEndsAt.toMillis()) return;
    void maybeFinalize();
    const id = setInterval(() => void maybeFinalize(), 600);
    return () => clearInterval(id);
  }, [roomId, round, maybeFinalize]);

  const createRoom = useCallback(async () => {
    if (!userId) return;
    setError(null);
    setLoading(true);
    try {
      const t0 = Date.now();
      const id = await callCreatePrivateRoom();
      logPerf('createPrivateRoom', t0);
      setRoomId(id);
      prevRoundSeq.current = null;
      const t1 = Date.now();
      await callJoinPrivateRoom(id);
      logPerf('joinPrivateRoom', t1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const joinRoom = useCallback(async (code: string) => {
    if (!userId) return;
    const trimmed = code.trim();
    if (!trimmed) return;
    setError(null);
    setLoading(true);
    try {
      const snap = await firestore().doc(`rooms/${trimmed}`).get();
      if (!snap.exists) { setError('Room not found'); return; }
      setRoomId(trimmed);
      prevRoundSeq.current = null;
      const t0 = Date.now();
      await callJoinPrivateRoom(trimmed);
      logPerf('joinPrivateRoom', t0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Join failed');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const enterGlobal = useCallback(async () => {
    if (!userId) return;
    setError(null);
    setLoading(true);
    try {
      const t0 = Date.now();
      const { roomId: gid } = await callAssignGlobalRoom();
      logPerf('assignGlobalRoom', t0);
      setRoomId(gid);
      prevRoundSeq.current = null;
      const t1 = Date.now();
      await callJoinPrivateRoom(gid);
      logPerf('joinPrivateRoom(global)', t1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Global room failed');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const choose = useCallback(async (word: string) => {
    if (!roomId || !userId) return;
    setError(null);
    if (round?.phase === 'finish_window' && round.phaseEndsAt) {
      if (round.phaseEndsAt.toMillis() <= Date.now()) {
        await maybeFinalize();
        return;
      }
    }
    try {
      const t0 = Date.now();
      await callSubmitMove(roomId, word);
      logPerf('submitMove', t0);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Pick failed';
      if (msg.includes('finalizeFinishWindow')) {
        await maybeFinalize();
        setError('round is finalizing — try again.');
      } else {
        setError(msg);
      }
    }
  }, [roomId, userId, round, maybeFinalize]);

  const leaveRoom = useCallback(() => {
    setRoomId(null);
    setRound(null);
    setMyPlayer(null);
    setRoster([]);
    setError(null);
    setFinishCountdown(null);
    prevRoundSeq.current = null;
  }, []);

  const others = useMemo(() => roster.filter(p => p.id !== userId), [roster, userId]);

  return {
    roomId,
    roomMode,
    round,
    myPlayer,
    roster,
    others,
    error,
    loading,
    finishCountdown,
    roundToast,
    createRoom,
    joinRoom,
    enterGlobal,
    choose,
    leaveRoom,
  };
}
