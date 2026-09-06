import { useEffect, useState } from 'react';
import type { UsageSnapshot } from '@94ai/core';
import type { AppClientServices } from '@94ai/client';

export type UsageState =
  | { status: 'idle'; items: UsageSnapshot[] }
  | { status: 'loading'; items: UsageSnapshot[] }
  | { status: 'ready'; items: UsageSnapshot[] }
  | { status: 'error'; items: UsageSnapshot[]; message: string };

export function useUsage(services: AppClientServices, uid: string | null): UsageState {
  const [state, setState] = useState<UsageState>({ status: uid ? 'loading' : 'idle', items: [] });

  useEffect(() => {
    if (!uid) {
      setState({ status: 'idle', items: [] });
      return undefined;
    }
    setState({ status: 'loading', items: [] });
    return services.usage.subscribe(
      uid,
      (items) => setState({ status: 'ready', items }),
      (error) => setState({ status: 'error', items: [], message: error.message }),
    );
  }, [services, uid]);

  return state;
}
