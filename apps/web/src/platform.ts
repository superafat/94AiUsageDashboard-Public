import type { AppLocation, ClockClient, ConnectivityClient, NavigationClient } from '@94ai/client';

export function createBrowserConnectivity(): ConnectivityClient {
  return {
    current: () => navigator.onLine ? 'online' : 'offline',
    subscribe: (callback) => {
      const online = () => callback('online');
      const offline = () => callback('offline');
      window.addEventListener('online', online);
      window.addEventListener('offline', offline);
      return () => {
        window.removeEventListener('online', online);
        window.removeEventListener('offline', offline);
      };
    },
  };
}

export function createBrowserClock(): ClockClient {
  return {
    now: () => Date.now(),
    every: (ms, callback) => {
      const timer = window.setInterval(callback, ms);
      return () => window.clearInterval(timer);
    },
  };
}

function locationFromHash(): AppLocation {
  const raw = location.hash.replace(/^#\/?/, '');
  const [routeName = '', query = ''] = raw.split('?', 2);
  if (routeName === 'provider') {
    const providerId = new URLSearchParams(query).get('providerId');
    return providerId ? { route: 'provider', providerId } : { route: 'dashboard' };
  }
  if (routeName === 'usage' || routeName === 'resets' || routeName === 'help' || routeName === 'settings' || routeName === 'getting-started') {
    return { route: routeName };
  }
  return { route: 'dashboard' };
}

function hashForLocation(target: AppLocation): string {
  if (target.route === 'provider') {
    return `#/provider?${new URLSearchParams({ providerId: target.providerId })}`;
  }
  return `#/${target.route}`;
}

export function createBrowserNavigation(): NavigationClient {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((callback) => callback());
  let attached = false;
  const attach = () => {
    if (attached) return;
    window.addEventListener('popstate', notify);
    window.addEventListener('hashchange', notify);
    attached = true;
  };
  const detach = () => {
    if (!attached || listeners.size) return;
    window.removeEventListener('popstate', notify);
    window.removeEventListener('hashchange', notify);
    attached = false;
  };
  return {
    current: locationFromHash,
    navigate: (target) => {
      history.pushState(null, '', hashForLocation(target));
      notify();
    },
    subscribe: (callback) => {
      listeners.add(callback);
      attach();
      return () => {
        listeners.delete(callback);
        detach();
      };
    },
  };
}
