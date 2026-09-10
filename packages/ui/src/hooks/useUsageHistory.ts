import { useEffect, useState } from 'react';
import type { UsageHistorySnapshot } from '@94ai/core';
import type { AppClientServices } from '@94ai/client';

export type UsageHistoryState =
  | { status: 'idle'; items: UsageHistorySnapshot[] }
  | { status: 'loading'; items: UsageHistorySnapshot[] }
  | { status: 'ready'; items: UsageHistorySnapshot[] }
  | { status: 'error'; items: UsageHistorySnapshot[]; message: string };

type ScopedUsageHistoryState = {
  services: AppClientServices;
  uid: string | null;
  value: UsageHistoryState;
};

function initialValue(uid: string | null): UsageHistoryState {
  return uid ? { status: 'loading', items: [] } : { status: 'idle', items: [] };
}

export function useUsageHistory(services: AppClientServices, uid: string | null): UsageHistoryState {
  const [scoped, setScoped] = useState<ScopedUsageHistoryState>(() => ({ services, uid, value: initialValue(uid) }));
  const matchesScope = scoped.services === services && scoped.uid === uid;
  const effectiveState = matchesScope ? scoped.value : initialValue(uid);

  useEffect(() => {
    const scopeServices = services;
    const scopeUid = uid;
    let active = true;
    let lastGood: UsageHistorySnapshot[] = [];

    setScoped({ services: scopeServices, uid: scopeUid, value: initialValue(scopeUid) });
    if (!scopeUid) return () => { active = false; };

    const unsubscribe = scopeServices.history.subscribe(
      scopeUid,
      (items) => {
        if (!active) return;
        lastGood = items;
        setScoped({ services: scopeServices, uid: scopeUid, value: { status: 'ready', items } });
      },
      (error) => {
        if (!active) return;
        setScoped({ services: scopeServices, uid: scopeUid, value: { status: 'error', items: lastGood, message: error.message } });
      },
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, [services, uid]);

  return effectiveState;
}
