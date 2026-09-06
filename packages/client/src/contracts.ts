import type { UsageHistorySnapshot, UsageSnapshot } from '@94ai/core';

export interface AppUser { uid: string; displayName?: string }
export type BackendProfile =
  | { mode: 'self-hosted'; label: string }
  | { mode: 'official-app'; label: string };

export type AuthFailureCode = 'interaction-blocked' | 'cancelled' | 'network' | 'configuration' | 'unknown';

export class AuthClientError extends Error {
  constructor(readonly code: AuthFailureCode) {
    super(`Authentication failed: ${code}`);
    this.name = 'AuthClientError';
  }
}

export interface AuthClient {
  observe(callback: (user: AppUser | null) => void): () => void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

export interface UsageRepository {
  subscribe(uid: string, onValue: (items: UsageSnapshot[]) => void, onError: (error: Error) => void): () => void;
}

export interface UsageHistoryRepository {
  subscribe(uid: string, onValue: (items: UsageHistorySnapshot[]) => void, onError: (error: Error) => void): () => void;
}

export interface ConnectivityClient {
  current(): 'online' | 'offline';
  subscribe(callback: (state: 'online' | 'offline') => void): () => void;
}

export interface ClockClient {
  now(): number;
  every(ms: number, callback: () => void): () => void;
}

export type AppLocation =
  | { route: 'dashboard' }
  | { route: 'usage' }
  | { route: 'resets' }
  | { route: 'provider'; providerId: string }
  | { route: 'help' }
  | { route: 'settings' }
  | { route: 'getting-started' };
export type AppRoute = AppLocation['route'];

export interface NavigationClient {
  current(): AppLocation;
  navigate(location: AppLocation): void;
  subscribe(callback: () => void): () => void;
}

export interface AppClientServices {
  backendProfile: BackendProfile;
  auth: AuthClient;
  usage: UsageRepository;
  history: UsageHistoryRepository;
  connectivity: ConnectivityClient;
  clock: ClockClient;
  navigation: NavigationClient;
}
