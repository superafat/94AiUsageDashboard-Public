import { GoogleAuthProvider, signInWithPopup, signOut, type Auth, type UserCredential } from 'firebase/auth';

export function signInWithGoogle(auth: Auth): Promise<UserCredential> {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export function signOutUser(auth: Auth): Promise<void> {
  return signOut(auth);
}
