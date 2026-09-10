import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppClientServices } from '@94ai/client';
import {
  resolveFamilyEnabled,
  type ProviderPreference,
} from '@94ai/core';

export interface ProviderPreferencesState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: ProviderPreference[];
  hasObserved: boolean;
  isFamilyEnabled: (family: string) => boolean;
  isFamilySaving: (family: string) => boolean;
  familyError: (family: string) => string | undefined;
  setFamilyEnabled: (family: string, enabled: boolean) => Promise<void>;
}

type ScopedPreferencesState = {
  generation: number;
  services: AppClientServices;
  uid: string | null;
  items: ProviderPreference[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  hasObserved: boolean;
  message?: string;
};

function initialScoped(generation: number, services: AppClientServices, uid: string | null): ScopedPreferencesState {
  if (!services.preferences) {
    return {
      generation,
      services,
      uid,
      items: [],
      status: 'ready',
      hasObserved: true,
    };
  }
  return {
    generation,
    services,
    uid,
    items: [],
    status: uid ? 'loading' : 'idle',
    hasObserved: false,
  };
}

export function useProviderPreferences(
  services: AppClientServices,
  uid: string | null,
): ProviderPreferencesState {
  const generationRef = useRef(0);
  const [scoped, setScoped] = useState<ScopedPreferencesState>(() => initialScoped(generationRef.current, services, uid));
  const [savingFamilies, setSavingFamilies] = useState<Map<string, boolean>>(() => new Map());
  const [familyErrors, setFamilyErrors] = useState<Map<string, string>>(() => new Map());

  const matchesScope = scoped.generation === generationRef.current && scoped.services === services && scoped.uid === uid;
  const effectiveItems = matchesScope ? scoped.items : [];
  const effectiveStatus = matchesScope ? scoped.status : (uid ? 'loading' : 'idle');
  const effectiveHasObserved = matchesScope ? scoped.hasObserved : false;

  useEffect(() => {
    const currentGen = ++generationRef.current;
    const scopeServices = services;
    const scopeUid = uid;
    let active = true;

    setScoped(initialScoped(currentGen, scopeServices, scopeUid));
    setSavingFamilies(new Map());
    setFamilyErrors(new Map());

    if (!scopeUid) return () => { active = false; };

    // Service seam: if preferences repository is not provided (e.g. legacy test harnesses)
    if (!scopeServices.preferences) {
      return () => { active = false; };
    }

    const unsubscribe = scopeServices.preferences.subscribe(
      scopeUid,
      (items) => {
        if (!active) return;
        setScoped((prev) => {
          if (prev.generation !== currentGen) return prev;
          return {
            ...prev,
            items,
            status: 'ready',
            hasObserved: true,
          };
        });
      },
      (error) => {
        if (!active) return;
        setScoped((prev) => {
          if (prev.generation !== currentGen) return prev;
          return {
            ...prev,
            items: prev.hasObserved ? prev.items : [],
            status: 'error',
            message: error.message,
          };
        });
      },
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, [services, uid]);

  const preferencesMap = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const item of effectiveItems) {
      map[item.family] = item.enabled;
    }
    return map;
  }, [effectiveItems]);

  const isFamilyEnabled = useCallback(
    (family: string): boolean => {
      if (!matchesScope) return false;
      if (!scoped.hasObserved) return false;

      // If OFF is saving, hide dependent source conservatively until acknowledged
      const savingTarget = savingFamilies.get(family);
      if (savingTarget === false) {
        return false;
      }

      return resolveFamilyEnabled(family, preferencesMap);
    },
    [matchesScope, scoped.hasObserved, savingFamilies, preferencesMap],
  );

  const isFamilySaving = useCallback(
    (family: string) => savingFamilies.has(family),
    [savingFamilies],
  );

  const familyError = useCallback(
    (family: string) => familyErrors.get(family),
    [familyErrors],
  );

  const setFamilyEnabled = useCallback(
    async (family: string, enabled: boolean): Promise<void> => {
      if (!uid) {
        throw new Error('User is not authenticated');
      }
      if (services.connectivity && services.connectivity.current() === 'offline') {
        const msg = '網路離線，無法儲存設定';
        setFamilyErrors((prev) => new Map(prev).set(family, msg));
        throw new Error(msg);
      }

      const saveGeneration = generationRef.current;
      setSavingFamilies((prev) => new Map(prev).set(family, enabled));
      setFamilyErrors((prev) => {
        const next = new Map(prev);
        next.delete(family);
        return next;
      });

      try {
        if (services.preferences) {
          await services.preferences.setPreference(uid, family, enabled);
        } else {
          // In-memory fallback for seam
          if (generationRef.current === saveGeneration) {
            setScoped((prev) => ({
              ...prev,
              items: [
                ...prev.items.filter((i) => i.family !== family),
                {
                  schemaVersion: 1,
                  userId: uid,
                  family,
                  enabled,
                  updatedAt: new Date().toISOString(),
                },
              ],
            }));
          }
        }
      } catch (err) {
        if (generationRef.current === saveGeneration) {
          const message = err instanceof Error ? err.message : String(err);
          setFamilyErrors((prev) => new Map(prev).set(family, message));
        }
        throw err;
      } finally {
        if (generationRef.current === saveGeneration) {
          setSavingFamilies((prev) => {
            const next = new Map(prev);
            next.delete(family);
            return next;
          });
        }
      }
    },
    [uid, services],
  );

  return {
    status: effectiveStatus,
    items: effectiveItems,
    hasObserved: effectiveHasObserved,
    isFamilyEnabled,
    isFamilySaving,
    familyError,
    setFamilyEnabled,
  };
}
