import * as admin from 'firebase-admin';

admin.initializeApp();

export {
  advanceRound,
  assignGlobalRoom,
  createPrivateRoom,
  deleteAccount,
  finalizeFinishWindow,
  heartbeat,
  joinPrivateRoom,
  leaveRoom,
  submitMove,
} from './callables';

export {ghostFinalizer} from './scheduled';
export {syncPublicProfile} from './triggers';
