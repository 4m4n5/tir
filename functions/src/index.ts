import * as admin from 'firebase-admin';

admin.initializeApp();

export {
  assignGlobalRoom,
  createPrivateRoom,
  finalizeFinishWindow,
  joinPrivateRoom,
  submitMove,
} from './callables';
