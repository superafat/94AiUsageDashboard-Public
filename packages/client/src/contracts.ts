import type {
  ProviderPreference,
  PushProducerRecord,
  ResetCommandReceipt,
  ResetCommandRequestRecord,
  ResetCreditItem,
  ResetInventoryEnvelope,
  PushSubscriptionRecord,
  UsageHistorySnapshot,
  UsageSnapshot,
} from '@94ai/core';

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

export interface ProviderPreferencesRepository {
  subscribe(uid: string, onValue: (items: ProviderPreference[]) => void, onError: (error: Error) => void): () => void;
  setPreference(uid: string, family: string, enabled: boolean): Promise<void>;
  setNotificationPreference(
    uid: string,
    family: string,
    patch: { lowQuota?: boolean; reset?: boolean },
  ): Promise<void>;
}

export type PushPermissionStatus =
  | 'unsupported'
  | 'ios_needs_home_screen'
  | 'default'
  | 'granted'
  | 'denied';

export interface PushNotificationService {
  reconcileSession?(uid: string | null): Promise<void>;
  getPermissionStatus(): Promise<PushPermissionStatus>;
  requestPermission(): Promise<NotificationPermission>;
  isSupported(): boolean;
  subscribe(uid: string, producer: PushProducerRecord): Promise<PushSubscriptionRecord>;
  unsubscribe(uid: string): Promise<void>;
  getCurrentSubscription(uid: string): Promise<PushSubscriptionRecord | null>;
  requestTestPush(uid: string, targetDeviceId: string): Promise<void>;
  subscribeProducers(
    uid: string,
    onValue: (producers: PushProducerRecord[]) => void,
    onError?: (err: Error) => void,
  ): () => void;
  subscribeSubscriptions(
    uid: string,
    onValue: (subscriptions: PushSubscriptionRecord[]) => void,
    onError?: (err: Error) => void,
  ): () => void;
}


export interface ResetPairingPin {
  backendId: string;
  userId: string;
  deviceId: string;
  publicKey: string;
  browserId: string;
}

export type ResetVerifiedInventory =
  | { status: 'ready'; pin: ResetPairingPin; producer: PushProducerRecord; envelope: ResetInventoryEnvelope; credit: ResetCreditItem }
  | { status: 'unpaired' | 'key_mismatch' | 'unavailable' | 'unverified'; credit?: undefined };

export type ResetCommandProgress =
  | { status: 'waiting'; request: ResetCommandRequestRecord }
  | { status: 'executing'; request: ResetCommandRequestRecord; receipt: ResetCommandReceipt }
  | { status: 'terminal'; request: ResetCommandRequestRecord; receipt: ResetCommandReceipt }
  | { status: 'unverified'; request: ResetCommandRequestRecord }
  | { status: 'uncertain'; request: ResetCommandRequestRecord };

export interface ResetCommandService {
  subscribeProducers(uid: string, onValue: (items: PushProducerRecord[]) => void, onError?: (error: Error) => void): () => void;
  getPairing(uid: string, deviceId: string): ResetPairingPin | null;
  pair(uid: string, producer: PushProducerRecord): ResetPairingPin;
  verifyInventory(uid: string, producer: PushProducerRecord, envelope: ResetInventoryEnvelope): Promise<ResetVerifiedInventory>;
  subscribeInventory(uid: string, producer: PushProducerRecord, onValue: (value: ResetVerifiedInventory) => void, onError?: (error: Error) => void): () => void;
  dispatch(value: ResetVerifiedInventory): Promise<ResetCommandRequestRecord>;
  verifyReceipt(uid: string, producer: PushProducerRecord, request: ResetCommandRequestRecord, receipt: ResetCommandReceipt): Promise<ResetCommandProgress>;
  watchResult(uid: string, producer: PushProducerRecord, request: ResetCommandRequestRecord, onValue: (state: ResetCommandProgress) => void, onError?: (error: Error) => void): () => void;
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
  | { route: 'provider'; providerId: string; deviceId?: string }
  | { route: 'help' }
  | { route: 'settings' }
  | { route: 'getting-started' }
  | { route: 'updates' };

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
  preferences?: ProviderPreferencesRepository;
  notifications?: PushNotificationService;
  resetCommands?: ResetCommandService;
  connectivity: ConnectivityClient;
  clock: ClockClient;
  navigation: NavigationClient;
}
