import { describe, expect, it } from 'vitest';
import { MacOSKeychainCredentialStore, type SecurityRunner } from './credential-store';

function memoryRunner() {
  const items = new Map<string, string>();
  const calls: Array<{ args: string[]; input?: string }> = [];
  const runner: SecurityRunner = async (args, input) => {
    calls.push(input === undefined ? { args: [...args] } : { args: [...args], input });
    const account = args[args.indexOf('-a') + 1] ?? '';
    if (args[0] === 'add-generic-password') {
      if (input === undefined) throw new Error('missing input');
      items.set(account, input.endsWith('\n') ? input.slice(0, -1) : input);
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'find-generic-password') {
      const value = items.get(account);
      if (value === undefined) throw new Error('not found');
      return { stdout: `${value}\n`, stderr: '' };
    }
    if (args[0] === 'delete-generic-password') {
      items.delete(account);
      return { stdout: '', stderr: '' };
    }
    throw new Error('unexpected command');
  };
  return { runner, calls, items };
}

describe('MacOSKeychainCredentialStore', () => {
  it('chunks long credentials so no secret enters argv or the 128-char prompt limit', async () => {
    const fake = memoryRunner();
    const store = new MacOSKeychainCredentialStore('test-service', fake.runner);
    const secret = `AMf-${'aB_9-'.repeat(180)}-tail`;
    await store.set('firebase-refresh-token', secret);
    expect(await store.get('firebase-refresh-token')).toBe(secret);

    const writes = fake.calls.filter((call) => call.args[0] === 'add-generic-password');
    expect(writes.length).toBeGreaterThan(2);
    for (const call of writes) {
      expect(call.args.join(' ')).not.toContain(secret);
      expect((call.input?.trimEnd().length ?? 0)).toBeLessThanOrEqual(96);
    }
  });

  it('replaces generations and removes all parts on delete', async () => {
    const fake = memoryRunner();
    const store = new MacOSKeychainCredentialStore('test-service', fake.runner);
    await store.set('token', 'first-'.repeat(80));
    await store.set('token', 'second-'.repeat(90));
    expect(await store.get('token')).toBe('second-'.repeat(90));
    await store.delete('token');
    expect(await store.get('token')).toBeNull();
    expect([...fake.items.keys()].filter((key) => key.startsWith('token.')).length).toBe(0);
  });
});
