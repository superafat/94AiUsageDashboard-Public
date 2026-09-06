import type { AppClientServices } from '@94ai/client';
import { createFirebaseClients } from './firebase';
import { createBrowserClock, createBrowserConnectivity, createBrowserNavigation } from './platform';

type WebClientDependencies = Omit<AppClientServices, 'backendProfile'>;

export function createWebClientServices(dependencies?: WebClientDependencies): AppClientServices {
  const resolved = dependencies ?? {
    ...createFirebaseClients(),
    connectivity: createBrowserConnectivity(),
    clock: createBrowserClock(),
    navigation: createBrowserNavigation(),
  };
  return {
    backendProfile: { mode: 'self-hosted', label: 'Self-hosted Firebase' },
    ...resolved,
  };
}
