import { useEffect, useState } from 'react';
import type { UsageHistorySnapshot } from '@94ai/core';
import type { AppClientServices } from '@94ai/client';

export type UsageHistoryState =
  | { status: 'idle'; items: UsageHistorySnapshot[] }
  | { status: 'loading'; items: UsageHistorySnapshot[] }
  | { status: 'ready'; items: UsageHistorySnapshot[] }
  | { status: 'error'; items: UsageHistorySnapshot[]; message: string };

export function useUsageHistory(services: AppClientServices, uid: string | null): UsageHistoryState {
  const [state, setState] = useState<UsageHistoryState>({ status: uid ? 'loading' : 'idle', items: [] });
  useEffect(() => {
    if (!uid) { setState({ status: 'idle', items: [] }); return undefined; }
    setState({ status: 'loading', items: [] });
    let lastGood: UsageHistorySnapshot[] = [];
    return services.history.subscribe(uid,
      (items) => { lastGood = items; setState({ status: 'ready', items }); },
      (error) => setState({ status: 'error', items: lastGood, message: error.message }),
    );
  }, [services, uid]);
  return state;
}
