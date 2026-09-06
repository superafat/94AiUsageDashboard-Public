// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collectionGroup, doc, onSnapshot, query, setDoc, where } from 'firebase/firestore';
import { AppRoot } from '@94ai/ui';
import type { AppClientServices } from '@94ai/client';
import { parseUsageSnapshot } from '@94ai/core';

let env: RulesTestEnvironment;

function snapshot(uid: string, providerId: string, resources: Record<string, unknown>) {
  const now = Date.now();
  return {
    schemaVersion: 1, userId: uid, deviceId: 'device-web', providerId,
    fetchedAt: new Date(now - 10_000).toISOString(), syncedAt: new Date().toISOString(),
    expiresAt: new Date(now + 300_000).toISOString(), stale: false, resources,
  };
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-94aiusage',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') },
  });
});

afterAll(async () => { cleanup(); await env.cleanup(); });

describe('Firestore -> web acceptance', () => {
  it('renders all three v1 providers from the same authenticated Firestore user', async () => {
    const db = env.authenticatedContext('alice').firestore();
    const providers = [
      ['codex', { weekly: { kind: 'consumption', unit: 'percent', remaining: 20 } }],
      ['antigravity', { geminiSession: { kind: 'consumption', unit: 'percent', remaining: 96 } }],
      ['claude@team-a', { session: { kind: 'consumption', unit: 'percent', remaining: 63 } }],
    ] as const;
    for (const [providerId, resources] of providers) {
      await setDoc(doc(db, `users/alice/devices/device-web/providers/${providerId}`), snapshot('alice', providerId, resources));
    }

    const services: AppClientServices = {
      backendProfile: { mode: 'self-hosted', label: 'Acceptance Firebase' },
      auth: {
        observe: (callback) => { callback({ uid: 'alice', displayName: 'Alice' }); return () => undefined; },
        signIn: async () => undefined,
        signOut: async () => undefined,
      },
      history: { subscribe: (_uid, onValue) => { queueMicrotask(() => onValue([])); return () => undefined; } },
      usage: {
        subscribe: (uid, onValue, onError) => onSnapshot(
          query(collectionGroup(db, 'providers'), where('userId', '==', uid)),
          (result) => onValue(result.docs.map((entry) => parseUsageSnapshot(entry.data()))),
          onError,
        ),
      },
      connectivity: { current: () => 'online', subscribe: () => () => undefined },
      clock: { now: () => Date.now(), every: () => () => undefined },
      navigation: { current: () => ({ route: 'dashboard' }), navigate: () => undefined, subscribe: () => () => undefined },
    };

    render(<AppRoot services={services} />);
    expect(await screen.findByRole('heading', { name: 'Codex' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Antigravity' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Claude Code' })).toBeInTheDocument();
  });
});
