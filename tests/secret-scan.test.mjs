import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  candidateFiles,
  findSecretFindings,
  isGitRepo,
  parseAndVerifyManifest,
  scanRepository,
} from '../scripts/scan-secrets.mjs';

test('secret scan allows public config placeholders', () => {
  assert.deepEqual(findSecretFindings('VITE_FIREBASE_API_KEY=your-public-web-api-key', '.env.example'), []);
});

test('secret scan rejects credential-shaped values and admin material', () => {
  const cases = [
    ['AIza' + 'A'.repeat(35), '.env'],
    ['-----BEGIN ' + 'PRIVATE KEY-----\nabc', 'key.pem'],
    ['{"type":"service_' + 'account","private_key_id":"abc"}', 'admin.json'],
    ['refresh_' + 'token=1//' + 'abcdefghijklmnopqrstuvwxyz0123456789', '.env'],
  ];
  for (const [text, file] of cases) assert.ok(findSecretFindings(text, file).length > 0, file);
});

test('candidateFiles and scanRepository work in Git repository', () => {
  const cwd = process.cwd();
  if (!isGitRepo(cwd)) {
    return;
  }
  const files = candidateFiles(cwd);
  assert.ok(files.length > 50, 'must resolve files from git ls-files');
  assert.ok(files.includes('package.json'));

  const findings = scanRepository(cwd);
  assert.deepEqual(findings, [], 'clean workspace must have zero secret findings');
});

test('candidateFiles in non-Git directory validates PUBLIC_EXPORT_MANIFEST.sha256 and scans only manifest-listed files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-scan-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'clean content 1\n');
    fs.writeFileSync(path.join(tmpDir, 'file2.txt'), 'clean content 2\n');
    // An unlisted file (e.g. ignored or untracked local file)
    fs.writeFileSync(path.join(tmpDir, 'unlisted.txt'), 'should never be scanned\n');

    const hash1 = crypto.createHash('sha256').update('clean content 1\n').digest('hex');
    const hash2 = crypto.createHash('sha256').update('clean content 2\n').digest('hex');

    const manifestContent = `# source_commit: 0123456789abcdef0123456789abcdef01234567\n${hash1}  file1.txt\n${hash2}  file2.txt\n`;
    fs.writeFileSync(path.join(tmpDir, 'PUBLIC_EXPORT_MANIFEST.sha256'), manifestContent);

    assert.equal(isGitRepo(tmpDir), false);
    const files = candidateFiles(tmpDir);
    assert.deepEqual(files.sort(), ['file1.txt', 'file2.txt']);
    assert.ok(!files.includes('unlisted.txt'));

    const findings = scanRepository(tmpDir);
    assert.deepEqual(findings, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('candidateFiles refuses to scan non-Git directory without valid PUBLIC_EXPORT_MANIFEST.sha256', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-manifest-scan-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'clean content\n');
    assert.equal(isGitRepo(tmpDir), false);
    assert.throws(
      () => candidateFiles(tmpDir),
      /Refusing to scan secrets in non-Git directory without valid PUBLIC_EXPORT_MANIFEST\.sha256/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseAndVerifyManifest rejects directory traversal, absolute paths, missing files, and hash mismatches', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-manifest-scan-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'content\n');
    const validHash = crypto.createHash('sha256').update('content\n').digest('hex');

    // 1. Missing file
    fs.writeFileSync(
      path.join(tmpDir, 'PUBLIC_EXPORT_MANIFEST.sha256'),
      `${validHash}  nonexistent.txt\n`,
    );
    assert.throws(() => parseAndVerifyManifest(tmpDir), /Manifest-listed file does not exist/);

    // 2. Hash mismatch
    fs.writeFileSync(
      path.join(tmpDir, 'PUBLIC_EXPORT_MANIFEST.sha256'),
      `${'a'.repeat(64)}  file1.txt\n`,
    );
    assert.throws(() => parseAndVerifyManifest(tmpDir), /Manifest hash mismatch/);

    // 3. Absolute path
    fs.writeFileSync(
      path.join(tmpDir, 'PUBLIC_EXPORT_MANIFEST.sha256'),
      `${validHash}  /etc/passwd\n`,
    );
    assert.throws(() => parseAndVerifyManifest(tmpDir), /Absolute path forbidden/);

    // 4. Directory traversal
    fs.writeFileSync(
      path.join(tmpDir, 'PUBLIC_EXPORT_MANIFEST.sha256'),
      `${validHash}  ../outside.txt\n`,
    );
    assert.throws(() => parseAndVerifyManifest(tmpDir), /Path traversal forbidden/);

    // 5. Malformed line
    fs.writeFileSync(
      path.join(tmpDir, 'PUBLIC_EXPORT_MANIFEST.sha256'),
      `bad-line-content\n`,
    );
    assert.throws(() => parseAndVerifyManifest(tmpDir), /Invalid manifest entry/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('candidateFiles preserves non-ASCII tracked paths exactly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-unicode-'));
  const run = (args) => execFileSync('git', args, { cwd: tmpDir, encoding: 'utf8', stdio: 'pipe' });
  try {
    run(['init']);
    run(['config', 'user.name', 'Secret Scan Unicode']);
    run(['config', 'user.email', ['scan-unicode', 'example.com'].join('@')]);
    const relPath = '文件/安全說明.md';
    fs.mkdirSync(path.join(tmpDir, '文件'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, relPath), 'safe content\n');
    run(['add', relPath]);
    run(['commit', '-m', 'add unicode tracked path']);
    assert.ok(candidateFiles(tmpDir).includes(relPath), 'secret scanner must preserve exact non-ASCII tracked path');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
