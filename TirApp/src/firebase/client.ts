import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

export function ensureAuthed() {
  const user = auth().currentUser;
  if (user) {
    return user;
  }
  throw new Error('Not authenticated yet');
}

export const db = firestore();
export const firebaseAuth = auth();

