import { describe, expect, it } from "vitest";
import * as fsPromises from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { NotificationJournal } from "./notification-journal";
import type { QuotaNotificationEvent, QuotaNotificationState } from "@94ai/core";

function makeState(overrides: Partial<QuotaNotificationState> = {}): QuotaNotificationState {
  return {
    version: 1,
    backendId: "backend-a",
    userId: "user-1",
    deviceId: "device-1",
    providerId: "codex",
    resourceKey: "session",
    watermarkUsedBand: 30,
    lastRemainingPercent: 70,
    lastFetchedAt: "2026-09-10T11:55:00.000Z",
    enabled: true, notifyConsumption: true, notifyReset: true, unit: "percent", limit: 100, cycleStartedAt: "2026-09-10T11:55:00.000Z",
    ...overrides,
  };
}

function makeEvent(id: string, overrides: Partial<QuotaNotificationEvent> = {}): QuotaNotificationEvent {
  return {
    version: 1,
    eventId: id,
    backendId: "backend-a",
    userId: "user-1",
    deviceId: "device-1",
    providerId: "codex",
    resourceKey: "session",
    type: "consumption",
    observedAt: "2026-09-10T11:55:00.000Z",
    expiresAt: "2026-09-10T12:05:00.000Z",
    remainingPercent: 70,
    crossedBands: [30],
    ...overrides,
  };
}

describe("NotificationJournal", () => {
  it("rejects symlinked, malformed or non-regular root directories", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "journal-test-"));
    try {
      const symlinkDir = path.join(tmpDir, "symlink-target");
      fsSync.symlinkSync(tmpDir, symlinkDir);

      expect(() => new NotificationJournal({
        rootDir: symlinkDir,
        backendId: "backend-a",
        userId: "user-1",
        deviceId: "device-1",
      })).toThrow(/symlink/i);

      expect(() => new NotificationJournal({
        rootDir: path.join(tmpDir, "does-not-exist"),
        backendId: "backend-a",
        userId: "user-1",
        deviceId: "device-1",
      })).toThrow();
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("validates scoped identity and rejects identity mismatches", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "journal-test-"));
    try {
      const journal = new NotificationJournal({
        rootDir: tmpDir,
        backendId: "backend-a",
        userId: "user-1",
        deviceId: "device-1",
      });

      // Mismatched state userId
      const badState = makeState({ userId: "user-2" });
      await expect(journal.saveStateAndEvents(badState, [])).rejects.toThrow(/mismatch/i);

      // Mismatched event backendId
      const badEvent = makeEvent("evt-1", { backendId: "backend-b" });
      await expect(journal.saveStateAndEvents(makeState(), [badEvent])).rejects.toThrow(/mismatch/i);
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects payloads containing credentials or private local paths", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "journal-test-"));
    try {
      const journal = new NotificationJournal({
        rootDir: tmpDir,
        backendId: "backend-a",
        userId: "user-1",
        deviceId: "device-1",
      });

      const leakyEvent = makeEvent("evt-leaky", {
        resetProof: "not-a-real-proof" as never,
      });
      await expect(journal.saveStateAndEvents(makeState(), [leakyEvent])).rejects.toThrow(/invalid|sensitive/i);
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("persists state and pending events together atomically", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "journal-test-"));
    try {
      const journal = new NotificationJournal({
        rootDir: tmpDir,
        backendId: "backend-a",
        userId: "user-1",
        deviceId: "device-1",
      });

      const state = makeState();
      const event1 = makeEvent("evt-1");
      await journal.saveStateAndEvents(state, [event1]);

      const loadedState = await journal.getState("codex", "session");
      expect(loadedState).toEqual(state);

      const pending = await journal.getPendingEvents();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.eventId).toBe("evt-1");
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("deduplicates event appends on restart without resending IDs", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "journal-test-"));
    try {
      const journal1 = new NotificationJournal({
        rootDir: tmpDir,
        backendId: "backend-a",
        userId: "user-1",
        deviceId: "device-1",
      });

      const event = makeEvent("evt-dup");
      await journal1.saveStateAndEvents(makeState(), [event]);

      // Restart with journal2
      const journal2 = new NotificationJournal({
        rootDir: tmpDir,
        backendId: "backend-a",
        userId: "user-1",
        deviceId: "device-1",
      });

      // Appending duplicate event
      await journal2.saveStateAndEvents(makeState(), [event]);

      const pending = await journal2.getPendingEvents();
      expect(pending).toHaveLength(1);
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("acknowledges events and separates pending from acknowledged", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "journal-test-"));
    try {
      const journal = new NotificationJournal({
        rootDir: tmpDir,
        backendId: "backend-a",
        userId: "user-1",
        deviceId: "device-1",
      });

      const event1 = makeEvent("evt-ack-1");
      const event2 = makeEvent("evt-ack-2");
      await journal.saveStateAndEvents(makeState(), [event1, event2]);

      expect(await journal.getPendingEvents()).toHaveLength(2);

      await journal.acknowledgeEvents(["evt-ack-1"]);

      const remainingPending = await journal.getPendingEvents();
      expect(remainingPending).toHaveLength(1);
      expect(remainingPending[0]?.eventId).toBe("evt-ack-2");

      // Appending acknowledged event again is ignored
      await journal.saveStateAndEvents(makeState(), [event1]);
      expect(await journal.getPendingEvents()).toHaveLength(1);
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("enforces exclusive locks and does not break active locks", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "journal-test-"));
    try {
      const lockPath = path.join(tmpDir, "journal.lock");
      // Simulate external active lock
      fsSync.writeFileSync(lockPath, JSON.stringify({ pid: 999999, createdAt: new Date().toISOString() }), { flag: "wx" });

      const journal = new NotificationJournal({
        rootDir: tmpDir,
        backendId: "backend-a",
        userId: "user-1",
        deviceId: "device-1",
      });

      await expect(journal.saveStateAndEvents(makeState(), [])).rejects.toThrow(/locked/i);
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("prunes expired events safely", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "journal-test-"));
    try {
      const journal = new NotificationJournal({
        rootDir: tmpDir,
        backendId: "backend-a",
        userId: "user-1",
        deviceId: "device-1",
      });

      const expiredEvent = makeEvent("evt-expired", {
        observedAt: "2026-09-10T10:55:00.000Z", expiresAt: "2026-09-10T11:00:00.000Z", // valid event interval, expired at prune time
      });
      const validEvent = makeEvent("evt-valid", {
        expiresAt: "2026-09-10T12:05:00.000Z",
      });

      await journal.saveStateAndEvents(makeState(), [expiredEvent, validEvent]);
      await journal.pruneExpired(Date.parse("2026-09-10T12:00:00.000Z"));

      const pending = await journal.getPendingEvents();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.eventId).toBe("evt-valid");
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects corrupt journal without silently erasing prior state", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "journal-test-"));
    try {
      const journalPath = path.join(tmpDir, "journal.json");
      fsSync.writeFileSync(journalPath, "{ invalid json corrupt !! ");

      const journal = new NotificationJournal({
        rootDir: tmpDir,
        backendId: "backend-a",
        userId: "user-1",
        deviceId: "device-1",
      });

      await expect(journal.getState("codex", "session")).rejects.toThrow(/invalid_journal/);
      expect(fsSync.readFileSync(journalPath, 'utf8')).toBe("{ invalid json corrupt !! ");
      await expect(journal.getPendingEvents()).rejects.toThrow(/invalid_journal/);
      expect(fsSync.readFileSync(journalPath, 'utf8')).toBe("{ invalid json corrupt !! ");
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});


describe('coordinator journal preservation counterexamples', () => {
  async function owned(action: (rootDir: string, journal: NotificationJournal) => Promise<void>, maxBytes = 512 * 1024) {
    const rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(),'usage28-owned-'));
    try { await action(rootDir,new NotificationJournal({rootDir,backendId:'backend-a',userId:'user-1',deviceId:'device-1',maxBytes})); }
    finally { await fsPromises.rm(rootDir,{recursive:true,force:true}); }
  }
  it('fails closed on corrupt existing storage instead of clearing history', async () => {
    await owned(async (rootDir,journal) => {
      await fsPromises.writeFile(path.join(rootDir,'journal.json'),'{not valid json');
      await expect(journal.getPendingEvents()).rejects.toThrow();
      expect(await fsPromises.readFile(path.join(rootDir,'journal.json'),'utf8')).toBe('{not valid json');
    });
  });
  it('does not overwrite another provider state sharing the session resource name', async () => {
    await owned(async (rootDir,journal) => {
      await journal.saveStateAndEvents(makeState(),[]);
      await journal.saveStateAndEvents(makeState({providerId:'claude'}),[]);
      const data=JSON.parse(await fsPromises.readFile(path.join(rootDir,'journal.json'),'utf8'));
      expect(Object.values(data.states).map((s: unknown) => (s as {providerId:string}).providerId).sort()).toEqual(['claude','codex']);
    });
  });
  it('honors byte limit before writing any oversized journal', async () => {
    await owned(async (rootDir,journal) => {
      await expect(journal.saveStateAndEvents(makeState(),[makeEvent('event-bounded')])).rejects.toThrow();
      expect(fsSync.existsSync(path.join(rootDir,'journal.json'))).toBe(false);
    },64);
  });
});


it('pins journal identity rather than following a later-mutated options object', async () => {
  const rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(),'usage28-owned-'));
  try {
    const options = {rootDir,backendId:'backend-a',userId:'user-1',deviceId:'device-1'};
    const journal = new NotificationJournal(options);
    options.userId = 'other-user';
    await journal.saveStateAndEvents(makeState(), []);
    await expect(journal.saveStateAndEvents(makeState({userId:'other-user'}), [])).rejects.toThrow();
  } finally { await fsPromises.rm(rootDir,{recursive:true,force:true}); }
});


it('rejects a symbolic journal file without reading or changing its target', async () => {
  const rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(),'usage28-owned-'));
  try {
    const target = path.join(rootDir,'sentinel');await fsPromises.writeFile(target,'untouched');
    await fsPromises.symlink(target,path.join(rootDir,'journal.json'));
    const journal = new NotificationJournal({rootDir,backendId:'backend-a',userId:'user-1',deviceId:'device-1'});
    await expect(journal.getPendingEvents()).rejects.toThrow();
    await expect(journal.saveStateAndEvents(makeState(),[])).rejects.toThrow();
    expect(await fsPromises.readFile(target,'utf8')).toBe('untouched');
  } finally { await fsPromises.rm(rootDir,{recursive:true,force:true}); }
});
it('rejects a foreign journal scope without overwriting existing bytes', async () => {
  const rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(),'usage28-owned-'));
  try {
    const first = new NotificationJournal({rootDir,backendId:'backend-a',userId:'user-1',deviceId:'device-1'});
    await first.saveStateAndEvents(makeState(),[]);
    const before = await fsPromises.readFile(path.join(rootDir,'journal.json'),'utf8');
    const other = new NotificationJournal({rootDir,backendId:'other-backend',userId:'user-1',deviceId:'device-1'});
    await expect(other.getPendingEvents()).rejects.toThrow();
    expect(await fsPromises.readFile(path.join(rootDir,'journal.json'),'utf8')).toBe(before);
  } finally { await fsPromises.rm(rootDir,{recursive:true,force:true}); }
});
it('enforces state count and rejects unknown acknowledgements without losing pending records', async () => {
  const rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(),'usage28-owned-'));
  try {
    const journal = new NotificationJournal({rootDir,backendId:'backend-a',userId:'user-1',deviceId:'device-1',maxItems:1});
    await journal.saveStateAndEvents(makeState(),[makeEvent('event-one')]);
    const before = await fsPromises.readFile(path.join(rootDir,'journal.json'),'utf8');
    await expect(journal.saveStateAndEvents(makeState({providerId:'claude'}),[])).rejects.toThrow();
    await expect(journal.acknowledgeEvents(['not-pending'])).rejects.toThrow();
    expect(await fsPromises.readFile(path.join(rootDir,'journal.json'),'utf8')).toBe(before);
  } finally { await fsPromises.rm(rootDir,{recursive:true,force:true}); }
});
