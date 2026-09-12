import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getOrCreateLocalPushKeys } from './local-push-keys';

describe('getOrCreateLocalPushKeys', () => {
  it('generates VAPID keys lazily on first run and persists as 0600 file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-keys-test-'));
    try {
      const result = await getOrCreateLocalPushKeys({
        rootDir: tempDir,
        backendId: 'self-hosted',
        userId: 'user-1',
        deviceId: 'mac-1',
      });

      expect(result.status).toBe('ready');
      expect(result.keys?.publicKey).toBeTruthy();
      expect(result.keys?.privateKey).toBeTruthy();
      expect(result.publicKey).toBe(result.keys?.publicKey);

      // Re-reading yields exact same keys (no auto-rotation)
      const cached = await getOrCreateLocalPushKeys({
        rootDir: tempDir,
        backendId: 'self-hosted',
        userId: 'user-1',
        deviceId: 'mac-1',
      });
      expect(cached.status).toBe('ready');
      expect(cached.keys?.publicKey).toBe(result.keys?.publicKey);
      expect(cached.keys?.privateKey).toBe(result.keys?.privateKey);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed and reports corrupt without overwriting corrupted key file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-keys-corrupt-'));
    try {
      // First generate
      await getOrCreateLocalPushKeys({
        rootDir: tempDir,
        backendId: 'self-hosted',
        userId: 'user-1',
        deviceId: 'mac-1',
      });

      // Find the key file and corrupt it
      const subdirs = fs.readdirSync(path.join(tempDir, 'push-keys'));
      expect(subdirs.length).toBe(1);
      const keyFile = path.join(tempDir, 'push-keys', subdirs[0]!, 'vapid.json');
      fs.writeFileSync(keyFile, 'corrupted content');

      const result = await getOrCreateLocalPushKeys({
        rootDir: tempDir,
        backendId: 'self-hosted',
        userId: 'user-1',
        deviceId: 'mac-1',
      });

      expect(result.status).toBe('corrupt');
      expect(result.keys).toBeUndefined();
      // Verify corrupted content was preserved and NOT overwritten
      expect(fs.readFileSync(keyFile, 'utf8')).toBe('corrupted content');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects symlinks in key path', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-keys-symlink-'));
    try {
      const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'target-'));
      const keysDir = path.join(tempDir, 'push-keys');
      fs.symlinkSync(targetDir, keysDir);

      const result = await getOrCreateLocalPushKeys({
        rootDir: tempDir,
        backendId: 'self-hosted',
        userId: 'user-1',
        deviceId: 'mac-1',
      });
      // Should not follow symlinks
      expect(['corrupt', 'error']).toContain(result.status);
      fs.rmSync(targetDir, { recursive: true, force: true });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
