import { useEffect, useState, type ReactNode } from 'react';
import type { AppClientServices, AppLocation, AppUser } from '@94ai/client';
import {
  isSnapshotStale,
  REMOTE_SYNC_STALE_AFTER_MS,
  SOURCE_STALE_AFTER_MS,
  type UsageSnapshot,
} from '@94ai/core';
import { useUsage, type UsageState } from './hooks/useUsage';
import { useUsageHistory, type UsageHistoryState } from './hooks/useUsageHistory';
import { useProviderPreferences, type ProviderPreferencesState } from './hooks/useProviderPreferences';
import { AppShell } from './components/AppShell';
import { providerFamily, providerSort } from './provider-display';
import { screenForRoute } from './navigation';
import { DashboardScreen } from './screens/DashboardScreen';
import { GettingStartedScreen } from './screens/GettingStartedScreen';
import { HelpScreen } from './screens/HelpScreen';
import { ProviderDetailScreen } from './screens/ProviderDetailScreen';
import { ResetCreditsScreen } from './screens/ResetCreditsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { UsageStatsScreen } from './screens/UsageStatsScreen';
import { WelcomeScreen } from './screens/WelcomeScreen';

export { REMOTE_SYNC_STALE_AFTER_MS, SOURCE_STALE_AFTER_MS, isSnapshotStale };

export function visibleUsageItems(items: UsageSnapshot[], now: number): UsageSnapshot[] {
  return items.filter((item) => {
    if (!isSnapshotStale(item, now)) return true;
    if (Object.keys(item.resources).length === 0) return false;
    return !items.some((candidate) =>
      candidate !== item
      && candidate.deviceId === item.deviceId
      && candidate.providerId === item.providerId
      && !isSnapshotStale(candidate, now));
  });
}


interface AuthenticatedRoutesProps {
  user: AppUser;
  usage: UsageState;
  history: UsageHistoryState;
  preferences: ProviderPreferencesState;
  location: AppLocation;
  services: AppClientServices;
}

function AuthenticatedRoutes({ user, usage, history, preferences, location, services }: AuthenticatedRoutesProps) {
  const [now, setNow] = useState(() => services.clock.now());
  const [offline, setOffline] = useState(() => services.connectivity.current() === 'offline');
  useEffect(() => services.connectivity.subscribe((state) => {
    setOffline(state === 'offline');
    if (state === 'online') setNow(services.clock.now());
  }), [services]);
  useEffect(() => services.clock.every(30_000, () => setNow(services.clock.now())), [services]);

  const allVisibleItems = visibleUsageItems(usage.items, now).sort(providerSort);
  const items = allVisibleItems.filter((item) => preferences.isFamilyEnabled(providerFamily(item.providerId)));
  const historyItems = history.items.filter((item) => preferences.isFamilyEnabled(providerFamily(item.providerId)));

  const screen = screenForRoute(location);
  const navigate = (target: AppLocation) => services.navigation.navigate(target);
  const shell = (children: ReactNode, hideTopbar = false) => <AppShell active={screen} userName={user.displayName ?? '帳號'} onNavigate={navigate} onSignOut={() => services.auth.signOut()} hideTopbar={hideTopbar}>{children}</AppShell>;

  const needsPreferences = ['dashboard', 'usage', 'resets', 'provider'].includes(location.route);
  if (needsPreferences && !preferences.hasObserved) {
    return shell(<section className="state-card" role={preferences.status === 'error' ? 'alert' : 'status'}>
      <strong>{preferences.status === 'error' ? '偏好設定讀取失敗' : '正在載入偏好設定…'}</strong>
      <p>確認你的資料來源選擇後才會顯示額度與統計。</p>
    </section>);
  }

  if (location.route === 'dashboard') return shell(<DashboardScreen
    userName={user.displayName ?? '帳號'} items={items} historyItems={historyItems} now={new Date(now)} offline={offline}
    loading={usage.status === 'loading' || (preferences.status === 'loading' && !preferences.hasObserved)}
    readError={usage.status === 'error' ? usage.message : (preferences.status === 'error' && !preferences.hasObserved ? '無法讀取偏好設定' : undefined)}
    hasStale={items.some((item) => isSnapshotStale(item, now))} onNavigate={navigate}
    isFamilyEnabled={preferences.isFamilyEnabled}
  />, true);
  if (location.route === 'usage') return shell(<UsageStatsScreen items={historyItems} now={new Date(now)} />);
  if (location.route === 'resets') return shell(<ResetCreditsScreen items={items} now={new Date(now)} />);
  if (location.route === 'provider') {
    const snapshot = items.find((item) =>
      item.providerId === location.providerId && (!location.deviceId || item.deviceId === location.deviceId)
    );
    if (!snapshot) {
      return shell(<section className="state-card"><strong>找不到這個資料來源</strong><p>回到首頁重新選擇 Provider。</p></section>);
    }

    const historyItem = historyItems.find((item) =>
      item.providerId === snapshot.providerId && item.deviceId === snapshot.deviceId
    );
    const historyError = history.status === 'error' ? history.message : undefined;
    const historySyncedAt = historyItem ? Date.parse(historyItem.syncedAt) : NaN;
    const historyStale = historyItem
      ? !Number.isFinite(historySyncedAt) || historySyncedAt > now || historySyncedAt + REMOTE_SYNC_STALE_AFTER_MS <= now
      : false;

    return shell(
      <ProviderDetailScreen
        snapshot={snapshot}
        historyError={historyError}
        historyStale={historyStale}
        now={new Date(now)}
        onNavigate={navigate}
      />
    );
  }
  if (location.route === 'help') return shell(<HelpScreen onNavigate={navigate} />);
  if (location.route === 'settings') return shell(<SettingsScreen
    userName={user.displayName ?? '帳號'}
    backendProfile={services.backendProfile}
    onNavigate={navigate}
    onSignOut={() => services.auth.signOut()}
    observedFamilies={allVisibleItems.map((item) => providerFamily(item.providerId))}
    status={preferences.status}
    hasObserved={preferences.hasObserved}
    isFamilyEnabled={preferences.isFamilyEnabled}
    isFamilySaving={preferences.isFamilySaving}
    familyError={preferences.familyError}
    onToggleFamily={preferences.setFamilyEnabled}
  />);
  return shell(<GettingStartedScreen signedIn onSignIn={() => services.auth.signIn()} onNavigate={navigate} />);
}

export function AppRoot({ services }: { services: AppClientServices }) {
  const [user, setUser] = useState<AppUser | null | undefined>(undefined);
  const [location, setLocation] = useState(() => services.navigation.current());
  useEffect(() => services.auth.observe(setUser), [services]);
  useEffect(() => services.navigation.subscribe(() => setLocation(services.navigation.current())), [services]);
  const usage = useUsage(services, user?.uid ?? null);
  const history = useUsageHistory(services, user?.uid ?? null);
  const preferences = useProviderPreferences(services, user?.uid ?? null);
  const navigate = (target: AppLocation) => services.navigation.navigate(target);

  if (user === undefined) return <main className="public-loading"><div className="state-card">正在確認登入狀態…</div></main>;
  if (user === null) {
    if (location.route === 'getting-started') return <main className="public-screen"><GettingStartedScreen signedIn={false} onSignIn={() => services.auth.signIn()} onNavigate={navigate} /></main>;
    if (location.route === 'help') return <main className="public-screen"><HelpScreen onNavigate={navigate} /></main>;
    return <WelcomeScreen onNavigate={navigate} />;
  }
  return <AuthenticatedRoutes user={user} usage={usage} history={history} preferences={preferences} location={location} services={services} />;
}
