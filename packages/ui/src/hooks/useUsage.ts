import { useEffect, useState } from 'react';
import type { UsageSnapshot } from '@94ai/core';
import type { AppClientServices } from '@94ai/client';

export type UsageState =
  | { status: 'idle'; items: UsageSnapshot[] }
  | { status: 'loading'; items: UsageSnapshot[] }
  | { status: 'ready'; items: UsageSnapshot[] }
  | { status: 'error'; items: UsageSnapshot[]; message: string };

type ScopedUsageState = {
  services: AppClientServices;
  uid: string | null;
  value: UsageState;
};

function initialValue(uid: string | null): UsageState {
  return uid ? { status: 'loading', items: [] } : { status: 'idle', items: [] };
}

export function useUsage(services: AppClientServices, uid: string | null): UsageState {
  const [scoped, setScoped] = useState<ScopedUsageState>(() => ({ services, uid, value: initialValue(uid) }));
  const matchesScope = scoped.services === services && scoped.uid === uid;
  const effectiveState = matchesScope ? scoped.value : initialValue(uid);

  useEffect(() => {
    const scopeServices = services;
    const scopeUid = uid;
    let active = true;
    let lastGood: UsageSnapshot[] = [];

    setScoped({ services: scopeServices, uid: scopeUid, value: initialValue(scopeUid) });
    if (!scopeUid) return () => { active = false; };

    const unsubscribe = scopeServices.usage.subscribe(
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
