import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { parseFirebaseConfig, signInWithGoogle, signOutUser, subscribeUsageHistory, subscribeUsageSnapshots } from '@94ai/firebase';
import { AuthClientError, type AuthClient, type UsageHistoryRepository, type UsageRepository } from '@94ai/client';

export function normalizeFirebaseAuthError(error: unknown): AuthClientError {
  const rawCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  switch (rawCode) {
    case 'auth/popup-blocked':
    case 'auth/operation-not-supported-in-this-environment':
      return new AuthClientError('interaction-blocked');
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return new AuthClientError('cancelled');
    case 'auth/network-request-failed':
      return new AuthClientError('network');
    case 'auth/unauthorized-domain':
    case 'auth/operation-not-allowed':
      return new AuthClientError('configuration');
    default:
      return new AuthClientError('unknown');
  }
}

export function createFirebaseClients(): { auth: AuthClient; usage: UsageRepository; history: UsageHistoryRepository } {
  const app = initializeApp(parseFirebaseConfig({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  }));
  const firebaseAuth = getAuth(app);
  const db = getFirestore(app);

  return {
    auth: {
      observe: (callback) => onAuthStateChanged(firebaseAuth, (user) => callback(
        user ? { uid: user.uid, ...(user.displayName ? { displayName: user.displayName } : {}) } : null,
      )),
      signIn: async () => {
        try { await signInWithGoogle(firebaseAuth); }
        catch (error) { throw normalizeFirebaseAuthError(error); }
      },
      signOut: () => signOutUser(firebaseAuth),
    },
    usage: {
      subscribe: (uid, onValue, onError) => subscribeUsageSnapshots(db, uid, onValue, onError),
    },
    history: {
      subscribe: (uid, onValue, onError) => subscribeUsageHistory(db, uid, onValue, onError),
    },
  };
}
