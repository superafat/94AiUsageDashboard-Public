import { describe, expect, it } from "vitest";
import type { UsageSnapshot } from "./schema";
import {
  evaluateQuotaNotifications,
  parseQuotaNotificationState,
  parseQuotaNotificationEvent,
  type QuotaNotificationState,
} from "./quota-notifications";

const baseNow = Date.parse("2026-09-10T12:00:00.000Z");

function createSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    schemaVersion: 1,
    userId: "user-1",
    deviceId: "device-1",
    providerId: "codex",
    plan: "Pro",
    fetchedAt: "2026-09-10T11:55:00.000Z",
    syncedAt: "2026-09-10T11:56:00.000Z",
    expiresAt: "2026-09-10T12:05:00.000Z",
    stale: false,
    resources: {
      session: {
        kind: "consumption",
        unit: "percent",
        used: 0,
        remaining: 100,
        limit: 100,
        resetsAt: "2026-09-10T15:00:00.000Z",
      },
    },
    ...overrides,
  };
}

describe("evaluateQuotaNotifications - consumption bands", () => {
  it("handles 100 -> 91 -> 89 with exactly one event at 89", async () => {
    const snap100 = createSnapshot({
      fetchedAt: "2026-09-10T11:50:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 0, remaining: 100, resetsAt: "2026-09-10T15:00:00.000Z" },
      },
    });
    const res100 = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap100,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });
    expect(res100.events).toHaveLength(0);
    expect(res100.state!.watermarkUsedBand).toBe(0);

    const snap91 = createSnapshot({
      fetchedAt: "2026-09-10T11:52:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 9, remaining: 91, resetsAt: "2026-09-10T15:00:00.000Z" },
      },
    });
    const res91 = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap91,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      previousState: res100.state,
      now: baseNow,
    });
    expect(res91.events).toHaveLength(0);
    expect(res91.state!.watermarkUsedBand).toBe(0);

    const snap89 = createSnapshot({
      fetchedAt: "2026-09-10T11:54:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 11, remaining: 89, resetsAt: "2026-09-10T15:00:00.000Z" },
      },
    });
    const res89 = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap89,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      previousState: res91.state,
      now: baseNow,
    });
    expect(res89.events).toHaveLength(1);
    expect(res89.events[0]?.type).toBe("consumption");
    expect(res89.events[0]?.remainingPercent).toBe(89);
    expect(res89.events[0]?.crossedBands).toEqual([10]);
    expect(res89.state!.watermarkUsedBand).toBe(10);
  });

  it("repeated 89 produces no new events", async () => {
    const snap89a = createSnapshot({
      fetchedAt: "2026-09-10T11:54:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 11, remaining: 89, resetsAt: "2026-09-10T15:00:00.000Z" },
      },
    });
    const res89a = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap89a,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });

    const snap89b = createSnapshot({
      fetchedAt: "2026-09-10T11:56:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 11, remaining: 89, resetsAt: "2026-09-10T15:00:00.000Z" },
      },
    });
    const res89b = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap89b,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      previousState: res89a.state,
      now: baseNow,
    });
    expect(res89b.events).toHaveLength(0);
    expect(res89b.state!.watermarkUsedBand).toBe(res89a.state!.watermarkUsedBand);
  });

  it("84 -> 58 produces one coalesced event crossing multiple bands", async () => {
    const snap84 = createSnapshot({
      fetchedAt: "2026-09-10T11:50:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 16, remaining: 84, resetsAt: "2026-09-10T15:00:00.000Z" },
      },
    });
    const res84 = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap84,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });
    expect(res84.state!.watermarkUsedBand).toBe(10);

    const snap58 = createSnapshot({
      fetchedAt: "2026-09-10T11:55:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 42, remaining: 58, resetsAt: "2026-09-10T15:00:00.000Z" },
      },
    });
    const res58 = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap58,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      previousState: res84.state,
      now: baseNow,
    });
    expect(res58.events).toHaveLength(1);
    expect(res58.events[0]?.type).toBe("consumption");
    expect(res58.events[0]?.crossedBands).toEqual([20, 30, 40]);
    expect(res58.events[0]?.remainingPercent).toBe(58);
    expect(res58.state!.watermarkUsedBand).toBe(40);
  });

  it("initial 63 produces none and baselines safely", async () => {
    const snap63 = createSnapshot({
      fetchedAt: "2026-09-10T11:50:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 37, remaining: 63, resetsAt: "2026-09-10T15:00:00.000Z" },
      },
    });
    const res63 = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap63,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });
    expect(res63.events).toHaveLength(0);
    expect(res63.state!.watermarkUsedBand).toBe(30);
    expect(res63.status).toBe("rebaselined");
  });

  it("same-window corrections 49 -> 51 -> 49 never replay", async () => {
    const snap49a = createSnapshot({
      fetchedAt: "2026-09-10T11:49:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 51, remaining: 49, resetsAt: "2026-09-10T15:00:00.000Z" },
      },
    });
    const res49a = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap49a,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });
    expect(res49a.state!.watermarkUsedBand).toBe(50);

    const snap51 = createSnapshot({
      fetchedAt: "2026-09-10T11:48:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 49, remaining: 51, resetsAt: "2026-09-10T15:00:00.000Z" },
      },
    });
    const res51 = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap51,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      previousState: res49a.state,
      now: baseNow,
    });
    expect(res51.events).toHaveLength(0);
    expect(res51.state!.watermarkUsedBand).toBe(50);

    const snap49b = createSnapshot({
      fetchedAt: "2026-09-10T11:52:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 51, remaining: 49, resetsAt: "2026-09-10T15:00:00.000Z" },
      },
    });
    const res49b = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap49b,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      previousState: res51.state,
      now: baseNow,
    });
    expect(res49b.events).toHaveLength(0);
    expect(res49b.state!.watermarkUsedBand).toBe(50);
  });
});

describe("evaluateQuotaNotifications - reset semantics", () => {
  it("confirmed newwindow refill generates reset event and re-arms consumption", async () => {
    const snapLow = createSnapshot({
      fetchedAt: "2026-09-10T11:50:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 80, remaining: 20, resetsAt: "2026-09-10T15:00:00.000Z" },
      },
    });
    const resLow = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snapLow,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });

    const snapReset = createSnapshot({
      fetchedAt: "2026-09-10T11:55:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 0, remaining: 100, resetsAt: "2026-09-10T19:00:00.000Z" },
      },
    });
    const resReset = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snapReset,
      resourceKey: "session",
      notifyConsumption: true,
      sourceEnabled: true,
      notifyReset: true,
      previousState: resLow.state,
      now: baseNow,
    });

    expect(resReset.events).toHaveLength(1);
    expect(resReset.events[0]?.type).toBe("reset");
    expect(resReset.events[0]?.resetProof).toBe("window_advanced_full_replenish");
    expect(resReset.state!.watermarkUsedBand).toBe(0);
    expect(resReset.state!.lastResetsAt).toBe("2026-09-10T19:00:00.000Z");
  });

  it("elapsedclock without replenishment does not generate reset", async () => {
    const snapPast = createSnapshot({
      fetchedAt: "2026-09-10T11:50:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 100, remaining: 0, resetsAt: "2026-09-10T11:40:00.000Z" },
      },
    });
    const res = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snapPast,
      resourceKey: "session",
      notifyConsumption: true,
      sourceEnabled: true,
      notifyReset: true,
      now: baseNow,
    });
    expect(res.events).toHaveLength(0);
  });

  it("partial rolling recovery does not produce false reset", async () => {
    const snap20 = createSnapshot({
      fetchedAt: "2026-09-10T11:49:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 80, remaining: 20, resetsAt: "2026-09-10T15:00:00.000Z" },
      },
    });
    const res20 = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap20,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });

    const snap60 = createSnapshot({
      fetchedAt: "2026-09-10T11:52:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 40, remaining: 60, resetsAt: "2026-09-10T19:00:00.000Z" },
      },
    });
    const res60 = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap60,
      resourceKey: "session",
      notifyConsumption: true,
      sourceEnabled: true,
      notifyReset: true,
      previousState: res20.state,
      now: baseNow,
    });
    expect(res60.events).toHaveLength(0);
    expect(res60.status).toBe("rebaselined");
  });

  it("ignores tiny time jitter on resetsAt (<60s) preserving cycle anchor", async () => {
    const snapA = createSnapshot({
      fetchedAt: "2026-09-10T11:49:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 50, remaining: 50, resetsAt: "2026-09-10T15:00:00.000Z" },
      },
    });
    const resA = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snapA,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });

    const snapJitter = createSnapshot({
      fetchedAt: "2026-09-10T11:50:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 50, remaining: 50, resetsAt: "2026-09-10T15:00:15.000Z" },
      },
    });
    const resJitter = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snapJitter,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      previousState: resA.state,
      now: baseNow,
    });
    expect(resJitter.events).toHaveLength(0);
    expect(resJitter.state!.lastResetsAt).toBe("2026-09-10T15:00:00.000Z");
  });
});

describe("evaluateQuotaNotifications - safety, bounds & invalid inputs", () => {
  it("rejects stale snapshot without generating events", async () => {
    const snap = createSnapshot({ stale: true });
    const res = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });
    expect(res.events).toHaveLength(0);
    expect(res.status).toBe("stale");
  });

  it("rejects future fetchedAt snapshot without generating events", async () => {
    const snap = createSnapshot({
      fetchedAt: new Date(baseNow + 60_000).toISOString(),
    });
    const res = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });
    expect(res.events).toHaveLength(0);
    expect(res.status).toBe("stale");
  });

  it("rejects snapshot with errorSummary", async () => {
    const snap = createSnapshot({
      errorSummary: "not_logged_in",
    });
    const res = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });
    expect(res.events).toHaveLength(0);
    expect(res.status).toBe("error_summary");
  });

  it("rejects out of order source times", async () => {
    const snap1 = createSnapshot({ fetchedAt: "2026-09-10T11:55:00.000Z" });
    const res1 = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap1,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });

    const snapOlder = createSnapshot({ fetchedAt: "2026-09-10T11:50:00.000Z" });
    const resOlder = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snapOlder,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      previousState: res1.state,
      now: baseNow,
    });
    expect(resOlder.events).toHaveLength(0);
    expect(resOlder.status).toBe("out_of_order");
  });

  it("detects plan change and rebaselines without emitting events", async () => {
    const snapPro = createSnapshot({ plan: "Pro", fetchedAt: "2026-09-10T11:50:00.000Z" });
    const resPro = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snapPro,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });

    const snapEnterprise = createSnapshot({
      plan: "Enterprise",
      fetchedAt: "2026-09-10T11:55:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 90, remaining: 10 },
      },
    });
    const resEnterprise = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snapEnterprise,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      previousState: resPro.state,
      now: baseNow,
    });
    expect(resEnterprise.events).toHaveLength(0);
    expect(resEnterprise.status).toBe("plan_changed");
    expect(resEnterprise.state!.plan).toBe("Enterprise");
  });

  it("rejects unknown or zero limit for non-percent resources", async () => {
    const snap = createSnapshot({
      resources: {
        tokens: { kind: "consumption", unit: "tokens", used: 100 },
      },
    });
    const res = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap,
      resourceKey: "tokens",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });
    expect(res.events).toHaveLength(0);
    expect(res.status).toBe("unknown_limit");
  });

  it("rejects contradictory used + remaining data", async () => {
    const snap = createSnapshot({
      resources: {
        session: { kind: "consumption", unit: "percent", used: 80, remaining: 50 },
      },
    });
    const res = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });
    expect(res.events).toHaveLength(0);
    expect(res.status).toBe("contradictory_data");
  });

  it("enforces scoped identity matching (cross-scope does not reuse watermark)", async () => {
    const snap = createSnapshot();
    const resUser1 = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      now: baseNow,
    });

    const resUser2 = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-2",
      deviceId: "device-1",
      snapshot: { ...snap, userId: "user-2" },
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      previousState: resUser1.state,
      now: baseNow,
    });
    expect(resUser2.state!.userId).toBe("user-2");
    expect(resUser2.status).toBe("rebaselined");
  });

  it("configured OFF produces no events and re-enabling baselines", async () => {
    const snap1 = createSnapshot({
      fetchedAt: "2026-09-10T11:50:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 50, remaining: 50 },
      },
    });
    const resOff = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap1,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: false,
      now: baseNow,
    });
    expect(resOff.events).toHaveLength(0);
    expect(resOff.status).toBe("disabled");

    const snap2 = createSnapshot({
      fetchedAt: "2026-09-10T11:55:00.000Z",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 60, remaining: 40 },
      },
    });
    const resOn = await evaluateQuotaNotifications({
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      snapshot: snap2,
      resourceKey: "session",
      notifyConsumption: true, notifyReset: true,
      sourceEnabled: true,
      previousState: resOff.state,
      now: baseNow,
    });
    expect(resOn.events).toHaveLength(0);
    expect(resOn.status).toBe("rebaselined");
    expect(resOn.state!.watermarkUsedBand).toBe(60);
  });
});

describe("parsing strict validation", () => {
  it("parses valid QuotaNotificationState and rejects invalid state", async () => {
    const valid: QuotaNotificationState = {
      version: 1,
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      providerId: "codex",
      resourceKey: "session",
      watermarkUsedBand: 30,
      lastRemainingPercent: 70,
      lastResetsAt: "2026-09-10T15:00:00.000Z",
      lastFetchedAt: "2026-09-10T11:55:00.000Z",
      plan: "Pro",

      enabled: true, notifyConsumption: true, notifyReset: true, unit: "percent", limit: 100, cycleStartedAt: "2026-09-10T11:55:00.000Z",
    };
    expect(parseQuotaNotificationState(valid)).toEqual(valid);

    expect(() => parseQuotaNotificationState({ ...valid, extraField: "bad" })).toThrow();
    expect(() => parseQuotaNotificationState({ ...valid, watermarkUsedBand: 35 })).toThrow();
    expect(() => parseQuotaNotificationState({ ...valid, version: 2 })).toThrow();
  });

  it("parses valid QuotaNotificationEvent and rejects invalid event", async () => {
    const valid = {
      version: 1 as const,
      eventId: "qne_1234567890abcdef",
      backendId: "backend-a",
      userId: "user-1",
      deviceId: "device-1",
      providerId: "codex",
      resourceKey: "session",
      type: "consumption" as const,
      observedAt: "2026-09-10T11:55:00.000Z",
      expiresAt: "2026-09-10T12:05:00.000Z",
      remainingPercent: 50,
      crossedBands: [50],
    };
    expect(parseQuotaNotificationEvent(valid)).toEqual(valid);

    expect(() => parseQuotaNotificationEvent({ ...valid, unknownField: true })).toThrow();
    expect(() => parseQuotaNotificationEvent({ ...valid, eventId: "" })).toThrow();
    expect(() => parseQuotaNotificationEvent({ ...valid, remainingPercent: 150 })).toThrow();
  });
});


describe('coordinator counterexamples - real opt-in and observation authority', () => {
  const settings = {backendId: 'backend-a', userId: 'user-1', deviceId: 'device-1', resourceKey: 'session', sourceEnabled: true, now: baseNow};
  const sample = (remaining: number, seconds: number, extra: Partial<UsageSnapshot> = {}) => createSnapshot({
    fetchedAt: new Date(baseNow - 60_000 + seconds * 1000).toISOString(), syncedAt: new Date(baseNow - 1000).toISOString(),
    resources: {session: {kind: 'consumption', unit: 'percent', remaining, resetsAt: '2026-09-10T15:00:00.000Z'}}, ...extra,
  });
  it('does not notify without explicit notification opt-in', async () => {
    const first = await evaluateQuotaNotifications({...settings, snapshot: sample(100, 0)});
    const next = await evaluateQuotaNotifications({...settings, previousState: first.state, snapshot: sample(80, 10)});
    expect(next.events).toHaveLength(0);
  });
  it('rejects another user snapshot despite the caller expected identity', async () => {
    const first = await evaluateQuotaNotifications({...settings, notifyConsumption: true, snapshot: sample(100, 0)});
    const next = await evaluateQuotaNotifications({...settings, notifyConsumption: true, previousState: first.state, snapshot: sample(20, 10, {userId: 'other-user'})});
    expect(next.events).toHaveLength(0);
    expect(next.status).toBe('invalid_input');
  });
  it('does not create invented full-quota baseline from stale first data', async () => {
    const first = await evaluateQuotaNotifications({...settings, notifyConsumption: true, snapshot: sample(20, 0, {stale: true})});
    const next = await evaluateQuotaNotifications({...settings, notifyConsumption: true, previousState: first.state, snapshot: sample(20, 10)});
    expect(next.events).toHaveLength(0);
  });
  it('rejects out-of-range evidence rather than clamping it into a refill', async () => {
    const invalid = sample(20, 0, {resources: {session: {kind:'consumption',unit:'tokens',limit:100,remaining:120}}});
    const result = await evaluateQuotaNotifications({...settings, notifyConsumption:true, snapshot: invalid});
    expect(['invalid_resource','contradictory_data']).toContain(result.status);
  });
  it('rejects coercible and non-finite persisted limits', async () => {
    const first = await evaluateQuotaNotifications({...settings, snapshot: sample(100,0)});
    for (const limit of ['bad', '100', 0, Infinity]) expect(() => parseQuotaNotificationState({...first.state, limit})).toThrow();
  });
  it('rejects invalid-calendar persisted observation dates', async () => {
    const first = await evaluateQuotaNotifications({...settings, snapshot: sample(100,0)});
    expect(() => parseQuotaNotificationState({...first.state, lastFetchedAt:'2026-02-30T00:00:00.000Z'})).toThrow();
  });
});


describe('bounded notification contracts and source changes', () => {
  const options = {backendId:'backend-a',userId:'user-1',deviceId:'device-1',resourceKey:'session',sourceEnabled:true,notifyConsumption:true,notifyReset:true,now:baseNow};
  it('does not invent reset authority from a proof string or malformed event bands', async () => {
    const first = await evaluateQuotaNotifications({...options,snapshot:createSnapshot()});
    const second = await evaluateQuotaNotifications({...options,previousState:first.state,snapshot:createSnapshot({fetchedAt:'2026-09-10T11:55:01.000Z',resources:{session:{kind:'consumption',unit:'percent',remaining:70,resetsAt:'2026-09-10T15:00:00.000Z'}}})});
    const event = second.events[0]!;
    for (const crossedBands of [[0],[10,10],Array(11).fill(10),[20,10]]) expect(() => parseQuotaNotificationEvent({...event,crossedBands})).toThrow();
    expect(() => parseQuotaNotificationEvent({...event,resetProof:'caller-says-success'})).toThrow();
    expect(() => parseQuotaNotificationEvent({...event,expiresAt:event.observedAt})).toThrow();
  });
  it('rejects another device snapshot and does not reuse its watermarks', async () => {
    const result = await evaluateQuotaNotifications({...options,snapshot:createSnapshot({deviceId:'other-device'})});
    expect(result.status).toBe('invalid_input'); expect(result.events).toHaveLength(0); expect(result.state).toBeUndefined();
  });
  it('baselines after units change without consumption or reset notifications', async () => {
    const first = await evaluateQuotaNotifications({...options,snapshot:createSnapshot()});
    const next = await evaluateQuotaNotifications({...options,previousState:first.state,snapshot:createSnapshot({fetchedAt:'2026-09-10T11:55:01.000Z',resources:{session:{kind:'consumption',unit:'tokens',limit:100,remaining:10,resetsAt:'2026-09-10T15:00:00.000Z'}}})});
    expect(next.status).toBe('plan_changed');expect(next.events).toHaveLength(0);
  });
  it('baselines backwards reset timestamps without reporting a reset', async () => {
    const first = await evaluateQuotaNotifications({...options,snapshot:createSnapshot()});
    const next = await evaluateQuotaNotifications({...options,previousState:first.state,snapshot:createSnapshot({fetchedAt:'2026-09-10T11:55:01.000Z',resources:{session:{kind:'consumption',unit:'percent',remaining:30,resetsAt:'2026-09-10T14:00:00.000Z'}}})});
    expect(next.status).toBe('rebaselined');expect(next.events).toHaveLength(0);
  });
  it('enabling reset alerts does not suppress an unrelated consumption crossing', async () => {
    const first = await evaluateQuotaNotifications({...options,notifyReset:false,preferenceRevision:'1',snapshot:createSnapshot()});
    const next = await evaluateQuotaNotifications({...options,preferenceRevision:'2',previousState:first.state,snapshot:createSnapshot({fetchedAt:'2026-09-10T11:55:01.000Z',resources:{session:{kind:'consumption',unit:'percent',remaining:80,resetsAt:'2026-09-10T15:00:00.000Z'}}})});
    expect(next.events).toHaveLength(1);expect(next.events[0]?.type).toBe('consumption');
  });
});
