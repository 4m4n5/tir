import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import {SafeAreaProvider, useSafeAreaInsets} from 'react-native-safe-area-context';
import {
  callAssignGlobalRoom,
  callCreatePrivateRoom,
  callFinalizeFinishWindow,
  callJoinPrivateRoom,
  callSubmitMove,
  leagueFromElo,
  logPerf,
  myPlayerDoc,
  playersCollection,
  roomDoc,
  roundDoc,
  type MyPlayerState,
  type RoundState,
  userDoc,
} from './src/rooms/privateRooms';

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <AppContent />
    </SafeAreaProvider>
  );
}

type RosterEntry = {id: string; currentWord: string};

function AppContent() {
  const safeAreaInsets = useSafeAreaInsets();
  const [firebaseReady, setFirebaseReady] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomMode, setRoomMode] = useState<string | null>(null);
  const [round, setRound] = useState<RoundState | null>(null);
  const [myPlayer, setMyPlayer] = useState<MyPlayerState | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [elo, setElo] = useState<number>(1200);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [joiningGlobal, setJoiningGlobal] = useState(false);
  const [finishCountdown, setFinishCountdown] = useState<number | null>(null);
  const [roundToast, setRoundToast] = useState<string | null>(null);
  const prevRoundSeq = useRef<number | null>(null);

  useEffect(() => {
    setFirebaseReady(true);
  }, []);

  useEffect(() => {
    if (!firebaseReady) return;
    return auth().onAuthStateChanged(user => {
      setUserId(user?.uid ?? null);
    });
  }, [firebaseReady]);

  useEffect(() => {
    if (!firebaseReady) return;
    if (userId) return;
    auth()
      .signInAnonymously()
      .catch(e => {
        setError(e instanceof Error ? e.message : 'Auth failed');
      });
  }, [firebaseReady, userId]);

  useEffect(() => {
    if (!firebaseReady || !userId) return;
    let cancelled = false;
    const ping = async () => {
      try {
        await firestore().doc('_debug/ping').set(
          {t: firestore.FieldValue.serverTimestamp(), uid: userId},
          {merge: true},
        );
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Firestore ping failed');
        }
      }
    };
    void ping();
    return () => {
      cancelled = true;
    };
  }, [firebaseReady, userId]);

  const rRound = useMemo(() => (roomId ? roundDoc(roomId) : null), [roomId]);
  const rPlayer = useMemo(
    () => (roomId && userId ? myPlayerDoc(roomId, userId) : null),
    [roomId, userId],
  );
  const rRoom = useMemo(() => (roomId ? roomDoc(roomId) : null), [roomId]);
  const rUser = useMemo(() => (userId ? userDoc(userId) : null), [userId]);

  useEffect(() => {
    if (!rRoom) {
      setRoomMode(null);
      return;
    }
    return rRoom.onSnapshot(snap => {
      const m = snap.data()?.mode;
      setRoomMode(typeof m === 'string' ? m : null);
    });
  }, [rRoom]);

  useEffect(() => {
    if (!rRound) {
      setRound(null);
      return;
    }
    return rRound.onSnapshot(snap => {
      const d = snap.data() as Partial<RoundState> | undefined;
      if (!d?.targetWord) {
        setRound(null);
        return;
      }
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
        setRoundToast(`New target — round ${rs.roundSeq}`);
        setTimeout(() => setRoundToast(null), 2200);
      }
      prevRoundSeq.current = rs.roundSeq;
      setRound(rs);
    });
  }, [rRound]);

  useEffect(() => {
    if (!rPlayer) {
      setMyPlayer(null);
      return;
    }
    return rPlayer.onSnapshot(snap => {
      const d = snap.data() as Partial<MyPlayerState> | undefined;
      if (!d?.options || !d.currentWord) {
        setMyPlayer(null);
        return;
      }
      const opts = d.options as string[];
      if (opts.length !== 4) {
        setMyPlayer(null);
        return;
      }
      setMyPlayer({
        currentWord: String(d.currentWord),
        options: opts as [string, string, string, string],
        usedOptionWords: d.usedOptionWords as string[] | undefined,
      });
    });
  }, [rPlayer]);

  useEffect(() => {
    if (!roomId) {
      setRoster([]);
      return;
    }
    return playersCollection(roomId).onSnapshot(snap => {
      setRoster(
        snap.docs.map(doc => ({
          id: doc.id,
          currentWord: String(doc.data()?.currentWord ?? '—'),
        })),
      );
    });
  }, [roomId]);

  useEffect(() => {
    if (!rUser) {
      setElo(1200);
      return;
    }
    return rUser.onSnapshot(snap => {
      const n = Number(snap.data()?.ratingElo ?? 1200);
      setElo(Number.isFinite(n) ? n : 1200);
    });
  }, [rUser]);

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
      if (res.advanced) {
        setFinishCountdown(null);
      }
    } catch {
      /* ignore transient races */
    }
  }, [roomId]);

  useEffect(() => {
    if (!roomId || !round || round.phase !== 'finish_window' || !round.phaseEndsAt) {
      return;
    }
    const ends = round.phaseEndsAt.toMillis();
    if (Date.now() < ends) {
      return;
    }
    void maybeFinalize();
    const id = setInterval(() => {
      void maybeFinalize();
    }, 600);
    return () => clearInterval(id);
  }, [roomId, round, maybeFinalize]);

  const createRoom = async () => {
    if (!userId) {
      setError('Not signed in yet.');
      return;
    }
    setError(null);
    setCreatingRoom(true);
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
      setCreatingRoom(false);
    }
  };

  const joinRoom = async () => {
    if (!userId) return;
    const trimmed = joinCode.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const snap = await firestore().doc(`rooms/${trimmed}`).get();
      if (!snap.exists) {
        setError('Room not found');
        return;
      }
      setRoomId(trimmed);
      prevRoundSeq.current = null;
      const t0 = Date.now();
      await callJoinPrivateRoom(trimmed);
      logPerf('joinPrivateRoom', t0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Join failed');
    }
  };

  const enterGlobal = async () => {
    if (!userId) return;
    setError(null);
    setJoiningGlobal(true);
    try {
      const t0 = Date.now();
      const {roomId: gid} = await callAssignGlobalRoom();
      logPerf('assignGlobalRoom', t0);
      setRoomId(gid);
      prevRoundSeq.current = null;
      const t1 = Date.now();
      await callJoinPrivateRoom(gid);
      logPerf('joinPrivateRoom(global)', t1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Global room failed');
    } finally {
      setJoiningGlobal(false);
    }
  };

  const choose = async (word: string) => {
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
        setError('Round is finalizing — try again.');
      } else {
        setError(msg);
      }
    }
  };

  const others = roster.filter(p => p.id !== userId);

  return (
    <View style={[styles.container, {paddingTop: safeAreaInsets.top}]}>
      <Text style={styles.title}>tir</Text>
      <Text style={styles.subtle}>user: {userId ?? 'signing in…'}</Text>
      {userId ? (
        <Text style={styles.subtle}>
          rating {Math.round(elo)} · {leagueFromElo(elo)}
        </Text>
      ) : null}

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Play</Text>
          <Text style={styles.subtle}>room: {roomId ?? 'none'}</Text>
          {roomMode ? <Text style={styles.subtle}>mode: {roomMode}</Text> : null}
          {round ? (
            <Text style={styles.subtle}>
              round #{round.roundSeq} · target: {round.targetWord}
            </Text>
          ) : roomId ? (
            <Text style={styles.subtle}>syncing round…</Text>
          ) : (
            <Text style={styles.subtle}>target: —</Text>
          )}
          {round?.phase === 'finish_window' ? (
            <Text style={styles.finishBanner}>
              FINISH WINDOW{finishCountdown !== null ? ` — ${finishCountdown}` : ''}
            </Text>
          ) : null}
          {roundToast ? <Text style={styles.toast}>{roundToast}</Text> : null}
          <Text style={styles.wordLabel}>your current word</Text>
          <Text style={styles.word}>{myPlayer?.currentWord ?? '—'}</Text>

          {others.length > 0 ? (
            <View style={styles.roster}>
              <Text style={styles.rosterTitle}>players</Text>
              {others.map(p => (
                <Text key={p.id} style={styles.rosterLine}>
                  {p.id.slice(0, 6)}… → {p.currentWord}
                </Text>
              ))}
            </View>
          ) : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          {roomId && myPlayer ? (
            <View style={styles.options}>
              {myPlayer.options.map((w, i) => (
                <TouchableOpacity
                  key={`${w}-${i}`}
                  style={styles.optionBtn}
                  onPress={() => choose(w)}>
                  <Text style={styles.optionText}>{w}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}

          <TouchableOpacity
            style={[styles.button, (!userId || creatingRoom) && styles.buttonDisabled]}
            disabled={!userId || creatingRoom}
            onPress={createRoom}>
            <Text style={styles.buttonText}>
              {creatingRoom ? 'Creating…' : 'Create private room'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.buttonAlt, (!userId || joiningGlobal) && styles.buttonDisabled]}
            disabled={!userId || joiningGlobal}
            onPress={enterGlobal}>
            <Text style={styles.buttonText}>
              {joiningGlobal ? 'Joining global…' : 'Enter global shard'}
            </Text>
          </TouchableOpacity>

          <View style={styles.row}>
            <TextInput
              value={joinCode}
              onChangeText={setJoinCode}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Room code"
              placeholderTextColor="#607089"
              style={styles.input}
            />
            <TouchableOpacity
              style={[styles.buttonSmall, (!userId || !joinCode.trim()) && styles.buttonDisabled]}
              onPress={joinRoom}>
              <Text style={styles.buttonText}>Join</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B0F1A',
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  scroll: {flex: 1},
  scrollContent: {paddingBottom: 32},
  title: {
    color: 'white',
    fontSize: 36,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginTop: 12,
  },
  subtle: {
    color: '#9AA4B2',
    marginTop: 6,
  },
  card: {
    marginTop: 18,
    backgroundColor: '#121A2B',
    borderRadius: 16,
    padding: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#24314A',
  },
  cardTitle: {
    color: 'white',
    fontSize: 18,
    fontWeight: '700',
  },
  wordLabel: {
    marginTop: 16,
    color: '#9AA4B2',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  word: {
    marginTop: 6,
    color: 'white',
    fontSize: 28,
    fontWeight: '700',
  },
  roster: {
    marginTop: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#24314A',
  },
  rosterTitle: {
    color: '#9AA4B2',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
  },
  rosterLine: {
    color: '#C8D0DC',
    fontSize: 13,
    marginTop: 2,
  },
  options: {
    marginTop: 14,
    gap: 10,
  },
  optionBtn: {
    backgroundColor: '#0E1524',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#24314A',
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  optionText: {
    color: 'white',
    fontWeight: '700',
    fontSize: 16,
  },
  button: {
    marginTop: 16,
    backgroundColor: '#5B8CFF',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonAlt: {
    marginTop: 10,
    backgroundColor: '#3D5A99',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: 'white',
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  input: {
    flex: 1,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#24314A',
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: 'white',
    backgroundColor: '#0E1524',
  },
  buttonSmall: {
    backgroundColor: '#5B8CFF',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: {
    marginTop: 12,
    color: '#FF6B6B',
    fontWeight: '600',
  },
  toast: {
    marginTop: 12,
    color: '#7CFFB2',
    fontWeight: '700',
    fontSize: 15,
  },
  finishBanner: {
    marginTop: 10,
    color: '#FFD56B',
    fontWeight: '800',
    fontSize: 15,
    letterSpacing: 0.5,
  },
});

export default App;
