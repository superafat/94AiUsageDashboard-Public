import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoot, isSnapshotStale } from './AppRoot';
import type { AppClientServices, AppLocation, AppUser } from '@94ai/client';
import type { UsageSnapshot } from '@94ai/core';

const base: UsageSnapshot = {
  schemaVersion: 1,
  userId: 'alice',
  deviceId: 'device-1',
  providerId: 'codex',
  plan: 'Pro 20x',
  fetchedAt: '2026-09-05T10:00:00.000Z',
  syncedAt: '2026-09-05T10:00:05.000Z',
  expiresAt: '2026-09-05T10:05:00.000Z',
  stale: false,
  resources: {
    session: { kind: 'consumption', unit: 'percent', remaining: 51, resetsAt: '2026-09-05T15:06:00.000Z' },
    weekly: { kind: 'consumption', unit: 'percent', remaining: 48, resetsAt: '2026-09-07T11:06:00.000Z' },
    rateLimitResets: { kind: 'balance', unit: 'resets', available: 3, expiries: ['2026-09-21T00:00:00.000Z'] },
  },
};

function fakeServices() {
  let authCallback: (user: AppUser | null) => void = () => undefined;
  let usageCallback: (items: UsageSnapshot[]) => void = () => undefined;
  let usageError: (error: Error) => void = () => undefined;
  let connectivityCallback: (state: 'online' | 'offline') => void = () => undefined;
  let navigationCallback: () => void = () => undefined;
  let appLocation: AppLocation = { route: 'dashboard' };
  let subscribeCount = 0;
  let signInCount = 0;
  const clockNow = Date.parse('2026-09-05T10:00:10.000Z');
  const services: AppClientServices = {
    backendProfile: { mode: 'self-hosted', label: 'Test Firebase' },
    auth: {
      observe: (callback) => { authCallback = callback; return () => undefined; },
      signIn: async () => { signInCount += 1; },
      signOut: async () => undefined,
    },
    usage: {
      subscribe: (_uid, onValue, onError) => { subscribeCount += 1; usageCallback = onValue; usageError = onError; return () => undefined; },
    },
    history: { subscribe: (_uid, onValue) => { queueMicrotask(() => onValue([])); return () => undefined; } },
    connectivity: {
      current: () => 'online',
      subscribe: (callback) => { connectivityCallback = callback; return () => undefined; },
    },
    clock: { now: () => clockNow, every: () => () => undefined },
    navigation: {
      current: () => appLocation,
      navigate: (location) => { appLocation = location; navigationCallback(); },
      subscribe: (callback) => { navigationCallback = callback; return () => undefined; },
    },
  };
  return {
    services,
    auth: (user: AppUser | null) => act(() => authCallback(user)),
    usage: (items: UsageSnapshot[]) => act(() => usageCallback(items)),
    fail: (message: string) => act(() => usageError(new Error(message))),
    connectivity: (state: 'online' | 'offline') => act(() => connectivityCallback(state)),
    navigate: (location: AppLocation) => act(() => services.navigation.navigate(location)),
    subscribeCount: () => subscribeCount,
    signInCount: () => signInCount,
  };
}

describe('App', () => {
  it('renders shared mobile and desktop product navigation for authenticated users', () => {
    const fake = fakeServices();
    render(<AppRoot services={fake.services} />);
    fake.auth({ uid: 'alice', displayName: 'Alice' });
    fake.usage([base]);
    expect(screen.getAllByRole('button', { name: '首頁' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: '使用統計' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: '重置額度' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: '設定' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('AI Usage').length).toBeGreaterThanOrEqual(1);
  });

  it('observes platform-neutral navigation locations', () => {
    const fake = fakeServices();
    render(<AppRoot services={fake.services} />);
    fake.auth({ uid: 'alice' });
    fake.usage([base]);
    expect(screen.getByRole('main')).toHaveAttribute('data-app-route', 'dashboard');
    fake.navigate({ route: 'usage' });
    expect(screen.getByRole('heading', { name: '使用統計' })).toBeInTheDocument();
    fake.navigate({ route: 'resets' });
    expect(screen.getByRole('heading', { name: '重置額度' })).toBeInTheDocument();
  });

  it('does not subscribe to Firestore while signed out', async () => {
    const fake = fakeServices();
    render(<AppRoot services={fake.services} />);
    fake.auth(null);
    expect(screen.getByRole('button', { name: '開始設定' })).toBeInTheDocument();
    expect(fake.subscribeCount()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '開始設定' }));
    fireEvent.click(screen.getByRole('button', { name: '使用 Google 登入' }));
    await act(async () => undefined);
    expect(fake.signInCount()).toBe(1);
  });

  it('renders loading, fresh, stale, no-data and provider-error states', () => {
    const fake = fakeServices();
    render(<AppRoot services={fake.services} />);
    fake.auth({ uid: 'alice', displayName: 'Alice' });
    expect(screen.getByText('正在讀取額度…')).toBeInTheDocument();
    fake.usage([base]);
    expect(screen.getByText('5 小時額度')).toBeInTheDocument();
    expect(screen.getByText('每週額度')).toBeInTheDocument();
    expect(screen.getByText('51%')).toBeInTheDocument();
    fake.usage([{ ...base, stale: true }]);
    expect(screen.getByText(/資料可能已過期/)).toBeInTheDocument();
    fake.usage([]);
    expect(screen.getByText(/目前沒有可顯示的額度資料/)).toBeInTheDocument();
    fake.usage([{ ...base, errorSummary: 'refresh failed' }]);
    expect(screen.getByText(/refresh failed/)).toBeInTheDocument();
  });

  it('omits absent session or weekly resources instead of inventing values', () => {
    const fake = fakeServices();
    render(<AppRoot services={fake.services} />);
    fake.auth({ uid: 'alice' });
    fake.usage([{ ...base, resources: { weekly: base.resources.weekly! } }]);
    expect(screen.queryByText('5 小時額度')).not.toBeInTheDocument();
    expect(screen.getByText('每週額度')).toBeInTheDocument();
    fake.usage([{ ...base, resources: { session: base.resources.session! } }]);
    expect(screen.getByText('5 小時額度')).toBeInTheDocument();
    expect(screen.queryByText('每週額度')).not.toBeInTheDocument();
  });

  it('does not confuse the OpenUsage cache expiry with a dead Mac sync', () => {
    const fake = fakeServices();
    render(<AppRoot services={fake.services} />);
    fake.auth({ uid: 'alice' });
    fake.usage([{
      ...base,
      stale: false,
      syncedAt: new Date().toISOString(),
      fetchedAt: new Date(Date.now() - 330_000).toISOString(),
      expiresAt: new Date(Date.now() - 30_000).toISOString(),
    }]);
    expect(screen.queryByText(/資料可能已過期/)).not.toBeInTheDocument();
  });

  it('marks data stale when the Mac has not completed a sync within the heartbeat window', () => {
    const fake = fakeServices();
    render(<AppRoot services={fake.services} />);
    fake.auth({ uid: 'alice' });
    fake.usage([{
      ...base,
      stale: false,
      syncedAt: '2000-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }]);
    expect(screen.getByText(/資料可能已過期/)).toBeInTheDocument();
  });

  it('shows read errors without creating mutation controls', () => {
    const fake = fakeServices();
    render(<AppRoot services={fake.services} />);
    fake.auth({ uid: 'alice' });
    fake.fail('permission denied');
    expect(screen.getByText(/permission denied/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(使用|兌換|立即重置|確認使用)$/ })).not.toBeInTheDocument();
  });

  it('renders Codex, Antigravity and Claude Code as first-class v1 providers', () => {
    const fake = fakeServices();
    render(<AppRoot services={fake.services} />);
    fake.auth({ uid: 'alice' });
    const antigravity: UsageSnapshot = {
      ...base,
      providerId: 'antigravity',
      plan: 'Ultra',
      resources: {
        geminiSession: { kind: 'consumption', unit: 'percent', remaining: 98 },
        geminiWeekly: { kind: 'consumption', unit: 'percent', remaining: 77 },
        nonGeminiSession: { kind: 'consumption', unit: 'percent', remaining: 100 },
        nonGeminiWeekly: { kind: 'consumption', unit: 'percent', remaining: 24 },
      },
    };
    const claude: UsageSnapshot = {
      ...base,
      providerId: 'claude@personal',
      plan: 'Max',
      resources: {
        session: { kind: 'consumption', unit: 'percent', remaining: 63 },
        weekly: { kind: 'consumption', unit: 'percent', remaining: 42 },
        fable: { kind: 'consumption', unit: 'percent', remaining: 80 },
      },
    };
    fake.usage([base, antigravity, claude]);
    expect(screen.getByRole('heading', { name: 'Codex' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Antigravity' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Claude Code' })).toBeInTheDocument();
    expect(screen.getByText('Gemini 5 小時')).toBeInTheDocument();
    expect(screen.getByText('Gemini 每週')).toBeInTheDocument();
    expect(screen.queryByText('非 Gemini 每週')).not.toBeInTheDocument();
    expect(screen.queryByText('Fable 每週')).not.toBeInTheDocument();
  });


  it('reports blocked login without exposing raw errors and allows retry', async () => {
    const fake = fakeServices();
    fake.services.auth.signIn = async () => { throw Object.assign(new Error('private-credential-value'), { code: 'interaction-blocked' }); };
    render(<AppRoot services={fake.services} />);
    fake.auth(null);
    fireEvent.click(screen.getByRole('button', { name: '開始設定' }));
    fireEvent.click(screen.getByRole('button', { name: '使用 Google 登入' }));
    await act(async () => undefined);
    expect(screen.getByRole('alert')).toHaveTextContent('登入流程未能開啟');
    expect(screen.queryByText(/private-credential-value/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '使用 Google 登入' })).toBeEnabled();
  });

  it('prevents duplicate login requests while a login is pending', async () => {
    const fake = fakeServices();
    let calls = 0;
    let finish!: () => void;
    fake.services.auth.signIn = () => { calls += 1; return new Promise<void>((resolve) => { finish = resolve; }); };
    render(<AppRoot services={fake.services} />);
    fake.auth(null);
    fireEvent.click(screen.getByRole('button', { name: '開始設定' }));
    const button = screen.getByRole('button', { name: '使用 Google 登入' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(calls).toBe(1);
    await act(async () => finish());
    expect(button).toBeEnabled();
  });

  it('immediately labels offline data and recovers when online without fabricating quotas', () => {
    const fake = fakeServices();
    render(<AppRoot services={fake.services} />);
    fake.auth({ uid: 'alice' });
    const now = Date.now();
    fake.usage([{ ...base, fetchedAt: new Date(now).toISOString(), syncedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString() }]);
    fake.connectivity('offline');
    expect(screen.getByRole('alert')).toHaveTextContent('目前離線');
    expect(screen.getByText('51%')).toBeInTheDocument();
    fake.connectivity('online');
    expect(screen.queryByText(/目前離線/)).not.toBeInTheDocument();
  });

  it('cannot make an old source snapshot fresh merely by uploading it again', () => {
    const now = Date.now();
    expect(isSnapshotStale({ ...base, stale: false, syncedAt: new Date(now).toISOString(), fetchedAt: new Date(now - 3_600_000).toISOString(), expiresAt: new Date(now - 3_300_000).toISOString() }, now)).toBe(true);
  });

  it('explains an unconnected v1 provider without inventing its quota', () => {
    const fake = fakeServices();
    render(<AppRoot services={fake.services} />);
    fake.auth({ uid: 'alice' });
    fake.usage([base]);
    const claude = screen.getByRole('region', { name: 'Claude Code 尚未連接' });
    expect(claude).toHaveTextContent('啟用對應來源並確認登入');
    expect(claude).not.toHaveTextContent('0%');
    expect(claude).not.toHaveTextContent('100%');
  });

  it('distinguishes a connected provider with no quota fields from a broken sync', () => {
    const fake = fakeServices();
    render(<AppRoot services={fake.services} />);
    fake.auth({ uid: 'alice' });
    fake.usage([{ ...base, providerId: 'claude', resources: {} }]);
    expect(screen.getByRole('heading', { name: 'Claude Code' })).toBeInTheDocument();
    expect(screen.getByText('來源已連接，但目前沒有可顯示的額度資料')).toBeInTheDocument();
    expect(screen.queryByText(/請確認 Mac 上的 OpenUsage 與同步程式是否正常/)).not.toBeInTheDocument();
  });

  it('hides an obsolete stale provider snapshot when the same device has a fresh replacement', () => {
    const fake = fakeServices();
    render(<AppRoot services={fake.services} />);
    fake.auth({ uid: 'alice' });
    const now = Date.now();
    const fresh = {
      ...base,
      providerId: 'claude',
      plan: 'Current',
      fetchedAt: new Date(now).toISOString(),
      syncedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 300_000).toISOString(),
      stale: false,
      resources: {},
    } satisfies UsageSnapshot;
    const obsolete = {
      ...fresh,
      providerId: 'claude@personal',
      plan: 'Old',
      fetchedAt: new Date(now - 3_600_000).toISOString(),
      syncedAt: new Date(now - 3_600_000).toISOString(),
      expiresAt: new Date(now - 3_300_000).toISOString(),
      stale: true,
      errorSummary: 'old login error',
    } satisfies UsageSnapshot;
    fake.usage([obsolete, fresh]);
    expect(screen.getAllByRole('heading', { name: 'Claude Code' })).toHaveLength(1);
    expect(screen.queryByText('old login error')).not.toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
  });

  it('keeps multiple fresh account-scoped snapshots for the same provider family', () => {
    const fake = fakeServices();
    render(<AppRoot services={fake.services} />);
    fake.auth({ uid: 'alice' });
    const now = Date.now();
    const fresh = {
      ...base,
      fetchedAt: new Date(now).toISOString(),
      syncedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 300_000).toISOString(),
      stale: false,
    } satisfies UsageSnapshot;
    fake.usage([
      { ...fresh, providerId: 'claude@personal', plan: 'Personal' },
      { ...fresh, providerId: 'claude@work', plan: 'Work' },
    ]);
    expect(screen.getAllByRole('heading', { name: 'Claude Code' })).toHaveLength(2);
    expect(screen.getByText('Personal')).toBeInTheDocument();
    expect(screen.getByText('Work')).toBeInTheDocument();
  });

  it('ignores an obsolete stale provider with no quota resources so it cannot trigger a global warning', () => {
    const fake = fakeServices();
    render(<AppRoot services={fake.services} />);
    fake.auth({ uid: 'alice' });
    const staleEmptyClaude: UsageSnapshot = {
      ...base,
      providerId: 'claude',
      plan: 'Old',
      fetchedAt: '2000-01-01T00:00:00.000Z',
      syncedAt: '2000-01-01T00:00:00.000Z',
      expiresAt: '2000-01-01T00:05:00.000Z',
      stale: false,
      resources: {},
    };
    fake.usage([base, staleEmptyClaude]);
    expect(screen.queryByText(/資料可能已過期/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Claude Code' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Claude Code 尚未連接' })).toBeInTheDocument();
  });

});
