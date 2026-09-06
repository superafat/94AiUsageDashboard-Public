import type { FirebaseOptions } from 'firebase/app';

type RequiredKey = 'apiKey' | 'authDomain' | 'projectId' | 'appId';
export type PublicFirebaseConfigInput = Partial<Record<RequiredKey, string>>;

function required(input: PublicFirebaseConfigInput, key: RequiredKey): string {
  const value = input[key];
  if (!value) throw new Error(`missing Firebase config: ${key}`);
  return value;
}

export function parseFirebaseConfig(input: PublicFirebaseConfigInput): FirebaseOptions {
  return {
    apiKey: required(input, 'apiKey'),
    authDomain: required(input, 'authDomain'),
    projectId: required(input, 'projectId'),
    appId: required(input, 'appId'),
  };
}
