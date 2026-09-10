import * as fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseQuotaNotificationEvent, parseQuotaNotificationState, SENSITIVE_PATTERN,
  type QuotaNotificationEvent, type QuotaNotificationState } from '@94ai/core';

export interface NotificationJournalOptions {
  rootDir: string; backendId: string; userId: string; deviceId: string;
  maxBytes?: number; maxItems?: number; maxAgeMs?: number;
}
interface JournalStorage {
  schemaVersion: 1; backendId: string; userId: string; deviceId: string;
  states: Record<string, QuotaNotificationState>;
  pendingEvents: QuotaNotificationEvent[];
  acknowledgedEvents: Array<{eventId: string; expiresAt: string}>;
}
const CAP_BYTES = 512 * 1024, CAP_ITEMS = 500, CAP_AGE = 14 * 86400_000;
function fail(code = 'invalid_journal'): never { throw new Error(code); }
function bounded(value: number | undefined, fallback: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n <= 0 || n > fallback) return fail();
  return n;
}
function safeText(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 128 || value.split('').some(char => char.charCodeAt(0) < 32) || SENSITIVE_PATTERN.test(value)) return fail();
  return value;
}
function object(value: unknown, allowed?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  if (allowed && Object.keys(value).some(key => !allowed.includes(key))) return fail();
  return value as Record<string, unknown>;
}
const keyOf = (state: Pick<QuotaNotificationState, 'providerId' | 'resourceKey'>) => JSON.stringify([state.providerId, state.resourceKey]);

/** Local synthetic/state storage only. No sender, scheduler or credential access. */
export class NotificationJournal {
  private readonly rootDir: string;
  private readonly rootIdentity: fs.Stats;
  private readonly file: string;
  private readonly lock: string;
  private readonly maxBytes: number;
  private readonly maxItems: number;
  private readonly maxAgeMs: number;
  private readonly options: Readonly<Pick<NotificationJournalOptions, 'backendId' | 'userId' | 'deviceId'>>;
  constructor(options: NotificationJournalOptions) {
    this.options = Object.freeze({backendId: safeText(options.backendId), userId: safeText(options.userId), deviceId: safeText(options.deviceId)});
    this.maxBytes = bounded(options.maxBytes, CAP_BYTES);
    this.maxItems = bounded(options.maxItems, CAP_ITEMS);
    this.maxAgeMs = bounded(options.maxAgeMs, CAP_AGE);
    const stat = fs.lstatSync(options.rootDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('invalid_journal_root_symlink');
    this.rootDir = fs.realpathSync(options.rootDir);
    this.rootIdentity = stat;
    this.file = path.join(this.rootDir, 'journal.json');
    this.lock = path.join(this.rootDir, 'journal.lock');
  }
  private checkRoot(): void {
    const stat = fs.lstatSync(this.rootDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.rootIdentity.dev || stat.ino !== this.rootIdentity.ino) fail('journal_root_changed');
  }
  private matches(value: {backendId: string; userId: string; deviceId: string}): boolean {
    return value.backendId === this.options.backendId && value.userId === this.options.userId && value.deviceId === this.options.deviceId;
  }
  private empty(): JournalStorage {
    return {schemaVersion: 1, backendId: this.options.backendId, userId: this.options.userId,
      deviceId: this.options.deviceId, states: {}, pendingEvents: [], acknowledgedEvents: []};
  }
  private validate(value: unknown): JournalStorage {
    const row = object(value, ['schemaVersion', 'backendId', 'userId', 'deviceId', 'states', 'pendingEvents', 'acknowledgedEvents']);
    if (row.schemaVersion !== 1 || !this.matches(row as unknown as JournalStorage)) return fail('journal_identity_mismatch');
    const rawStates = object(row.states);
    const pending = row.pendingEvents, acknowledged = row.acknowledgedEvents;
    if (!Array.isArray(pending) || !Array.isArray(acknowledged) || Object.keys(rawStates).length > this.maxItems ||
      pending.length > this.maxItems || acknowledged.length > this.maxItems) return fail('journal_item_limit');
    const states: Record<string, QuotaNotificationState> = {};
    for (const [key, raw] of Object.entries(rawStates)) {
      const state = parseQuotaNotificationState(raw);
      if (!this.matches(state) || key !== keyOf(state)) return fail('journal_identity_mismatch');
      states[key] = state;
    }
    const ids = new Set<string>();
    const pendingEvents = pending.map(raw => {
      const event = parseQuotaNotificationEvent(raw);
      if (!this.matches(event) || !Object.hasOwn(states, keyOf(event)) || ids.has(event.eventId)) return fail('journal_event_mismatch');
      ids.add(event.eventId); return event;
    });
    const acknowledgedEvents = acknowledged.map(raw => {
      const entry = object(raw, ['eventId', 'expiresAt']);
      const eventId = safeText(entry.eventId), expiresAt = safeText(entry.expiresAt);
      if (!/^[A-Za-z0-9._-]+$/.test(eventId) || !Number.isFinite(Date.parse(expiresAt)) || ids.has(eventId)) return fail();
      ids.add(eventId); return {eventId, expiresAt};
    });
    return {...this.empty(), states, pendingEvents, acknowledgedEvents};
  }
  private async locked<T>(action: () => T): Promise<T> {
    this.checkRoot();
    let fd: number;
    try { fd = fs.openSync(this.lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail('journal_locked'); throw error; }
    const identity = fs.fstatSync(fd);
    try { return action(); }
    finally {
      fs.closeSync(fd);
      const current = fs.lstatSync(this.lock);
      if (current.ino === identity.ino && current.dev === identity.dev && current.isFile() && !current.isSymbolicLink()) fs.unlinkSync(this.lock);
    }
  }
  private read(): JournalStorage {
    this.checkRoot();
    let fd: number;
    try { fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.empty(); return fail('journal_read_rejected'); }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > this.maxBytes) return fail('journal_file_rejected');
      const bytes = Buffer.alloc(this.maxBytes + 1);
      let count = 0;
      while (count < bytes.length) {
        const size = fs.readSync(fd, bytes, count, bytes.length - count, null);
        if (!size) break;
        count += size;
      }
      if (count > this.maxBytes) return fail('journal_byte_limit');
      const current = fs.lstatSync(this.file);
      if (current.ino !== stat.ino || current.dev !== stat.dev || !current.isFile() || current.isSymbolicLink()) return fail('journal_file_changed');
      try { return this.validate(JSON.parse(bytes.subarray(0, count).toString('utf8'))); }
      catch { return fail('invalid_journal'); }
    } finally { fs.closeSync(fd); }
  }
  private write(value: JournalStorage): void {
    this.checkRoot();
    const storage = this.validate(value);
    const bytes = Buffer.from(JSON.stringify(storage));
    if (bytes.length > this.maxBytes) return fail('journal_byte_limit');
    try {
      const stat = fs.lstatSync(this.file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return fail('journal_file_rejected');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temp = path.join(this.rootDir, 'journal.tmp.' + randomUUID());
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    let renamed = false;
    try {
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.checkRoot(); fs.renameSync(temp, this.file); renamed = true;
      const directory = fs.openSync(this.rootDir, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally { if (!renamed) fs.unlinkSync(temp); }
  }
  public async getState(providerId: string, resourceKey: string): Promise<QuotaNotificationState | undefined> {
    safeText(providerId); safeText(resourceKey);
    return this.locked(() => this.read().states[keyOf({providerId, resourceKey})]);
  }
  public async saveStateAndEvents(state: QuotaNotificationState, events: QuotaNotificationEvent[]): Promise<void> {
    const parsed = parseQuotaNotificationState(state);
    if (!this.matches(parsed)) return fail('state_identity_mismatch');
    if (!Array.isArray(events) || events.length > this.maxItems) return fail();
    const safeEvents = events.map(raw => {
      const event = parseQuotaNotificationEvent(raw);
      if (!this.matches(event) || keyOf(event) !== keyOf(parsed)) return fail('event_identity_mismatch');
      return event;
    });
    return this.locked(() => {
      const storage = this.read();
      const previous = storage.states[keyOf(parsed)];
      if (previous && Date.parse(parsed.lastFetchedAt) < Date.parse(previous.lastFetchedAt)) return fail('journal_out_of_order');
      storage.states[keyOf(parsed)] = parsed;
      const known = new Set([...storage.pendingEvents.map(event => event.eventId), ...storage.acknowledgedEvents.map(event => event.eventId)]);
      for (const event of safeEvents) if (!known.has(event.eventId)) { storage.pendingEvents.push(event); known.add(event.eventId); }
      this.write(storage);
    });
  }
  public async getPendingEvents(): Promise<QuotaNotificationEvent[]> { return this.locked(() => this.read().pendingEvents); }
  public async acknowledgeEvents(eventIds: string[]): Promise<void> {
    if (!Array.isArray(eventIds) || eventIds.length > this.maxItems) return fail();
    for (const id of eventIds) safeText(id);
    if (!eventIds.length) return;
    return this.locked(() => {
      const storage = this.read(), requested = new Set(eventIds);
      const known = new Set([...storage.pendingEvents.map(event => event.eventId), ...storage.acknowledgedEvents.map(event => event.eventId)]);
      if ([...requested].some(id => !known.has(id))) return fail('journal_unknown_ack');
      for (const event of storage.pendingEvents) if (requested.has(event.eventId)) storage.acknowledgedEvents.push({eventId: event.eventId, expiresAt: event.expiresAt});
      storage.pendingEvents = storage.pendingEvents.filter(event => !requested.has(event.eventId));
      this.write(storage);
    });
  }
  public async pruneExpired(now: number | Date = Date.now()): Promise<number> {
    const time = now instanceof Date ? now.getTime() : now;
    if (!Number.isFinite(time) || time < 0) return fail();
    return this.locked(() => {
      const storage = this.read(), before = storage.pendingEvents.length;
      storage.pendingEvents = storage.pendingEvents.filter(event => Date.parse(event.expiresAt) > time && time - Date.parse(event.observedAt) <= this.maxAgeMs);
      storage.acknowledgedEvents = storage.acknowledgedEvents.filter(event => Date.parse(event.expiresAt) > time);
      for (const [key, state] of Object.entries(storage.states)) if (time - Date.parse(state.lastFetchedAt) > this.maxAgeMs && !storage.pendingEvents.some(event => keyOf(event) === key)) delete storage.states[key];
      this.write(storage);
      return before - storage.pendingEvents.length;
    });
  }
}
