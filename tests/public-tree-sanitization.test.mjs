import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { auditPublicTree } from '../scripts/audit-public-release.mjs';
import { execFileSync } from 'node:child_process';

function isGitWorktree(cwd) {
  try {
    const res = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return res.trim() === 'true';
  } catch {
    return false;
  }
}

test('auditPublicTree reports zero blockers for current public tree', (t) => {
  if (!isGitWorktree(process.cwd())) {
    t.skip('Skipping git tree audit when running inside a non-Git exported release directory');
    return;
  }
  const findings = auditPublicTree(process.cwd());
  const blockers = findings.filter((f) => f.severity === 'BLOCKER');

  if (blockers.length > 0) {
    const summary = blockers.map((f) => `[${f.category}] ${f.path}: ${f.detail}`).join('\n');
    assert.equal(
      blockers.length,
      0,
      `Expected 0 tree blockers, found ${blockers.length}:\n${summary}`,
    );
  }
});

test('public tree contains no local user home directory paths', (t) => {
  if (!isGitWorktree(process.cwd())) {
    t.skip('Skipping git tree audit when running inside a non-Git exported release directory');
    return;
  }
  const findings = auditPublicTree(process.cwd());
  const homeFindings = findings.filter((f) => f.category === 'local_home_path');
  const summary = homeFindings.map((f) => f.path).join(', ');
  assert.equal(
    homeFindings.length,
    0,
    `Found local home path violations in ${homeFindings.length} files: ${summary}`,
  );
});

test('public tree contains no unreviewed binary evidence', (t) => {
  if (!isGitWorktree(process.cwd())) {
    t.skip('Skipping git tree audit when running inside a non-Git exported release directory');
    return;
  }
  const findings = auditPublicTree(process.cwd());
  const binaryFindings = findings.filter((f) => f.category === 'manual_review_required');
  const summary = binaryFindings.map((f) => `${f.path} (${f.detail})`).join(', ');
  assert.equal(
    binaryFindings.length,
    0,
    `Found unreviewed binaries in ${binaryFindings.length} files: ${summary}`,
  );
});

test('public tree contains no private Firebase environment markers', (t) => {
  if (!isGitWorktree(process.cwd())) {
    t.skip('Skipping git tree audit when running inside a non-Git exported release directory');
    return;
  }
  const findings = auditPublicTree(process.cwd());
  const firebaseFindings = findings.filter((f) => f.category === ['private', 'firebase', 'marker'].join('_'));
  const summary = firebaseFindings.map((f) => f.path).join(', ');
  assert.equal(
    firebaseFindings.length,
    0,
    `Found private Firebase markers in ${firebaseFindings.length} files: ${summary}`,
  );
});

test('public tree contains no personal email addresses', (t) => {
  if (!isGitWorktree(process.cwd())) {
    t.skip('Skipping git tree audit when running inside a non-Git exported release directory');
    return;
  }
  const findings = auditPublicTree(process.cwd());
  const emailFindings = findings.filter((f) => f.category === 'email_address');
  const summary = emailFindings.map((f) => f.path).join(', ');
  assert.equal(
    emailFindings.length,
    0,
    `Found email address violations in ${emailFindings.length} files: ${summary}`,
  );
});

test('.gitignore excludes sensitive credential formats and local development artifacts', () => {
  const gitignore = fs.readFileSync(path.resolve('.gitignore'), 'utf8');

  // Must exclude .env and .env.* while tracking .env.example
  assert.match(gitignore, /(?:^|\n)\.env\b/, '.gitignore must exclude .env');
  assert.match(gitignore, /(?:^|\n)\.env\.\*/, '.gitignore must exclude .env.*');
  assert.match(gitignore, /(?:^|\n)!\.env\.example\b/, '.gitignore must keep !.env.example tracked');

  // Must exclude key and certificate formats
  const requiredCertPatterns = ['*.pem', '*.key', '*.p12', '*.pfx', '*.crt', '*.cer'];
  for (const ext of requiredCertPatterns) {
    assert.ok(
      gitignore.includes(ext),
      `.gitignore must include key/cert pattern ${ext}`,
    );
  }

  // Must exclude logs, test results, OS metadata
  assert.match(gitignore, /\.log/, '.gitignore must exclude logs');
  assert.match(gitignore, /\.firebase/, '.gitignore must exclude .firebase');
  assert.match(gitignore, /\.DS_Store/, '.gitignore must exclude .DS_Store');
});

test('.env.example contains only public placeholder configuration', () => {
  const envExample = fs.readFileSync(path.resolve('.env.example'), 'utf8');
  assert.ok(envExample.includes('VITE_FIREBASE_PROJECT_ID='), 'must define VITE_FIREBASE_PROJECT_ID');
  assert.ok(envExample.includes('FIREBASE_PROJECT_ID='), 'must define FIREBASE_PROJECT_ID');

  // Must not contain actual secret tokens or keys
  assert.doesNotMatch(envExample, /AIza[0-9A-Za-z-_]{35}/, 'must not contain real Google API key');
  assert.doesNotMatch(envExample, /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36}/, 'must not contain GitHub token');
});

test('reviewed PNG evidence is preserved by exact SHA-256 allowlist and fails closed on unknown bytes', async (t) => {
  if (!isGitWorktree(process.cwd()) || !fs.existsSync('docs/evidence')) {
    t.skip('Skipping evidence file check in clean export directory');
    return;
  }
  const { computeFileSha256Sync, checkBinaryFile, loadPrivateReleaseBaseline, REVIEWED_BINARY_SHAS } = await import('../scripts/public-release-policy.mjs');
  const expectedPngs = [
    'docs/evidence/v1.5-desktop-home.png',
    'docs/evidence/v1.5-mobile-home.png',
    'docs/evidence/v1.5-mobile-usage.png',
  ];

  const privateBaseline = loadPrivateReleaseBaseline();
  assert.equal(privateBaseline.reviewedBinaries.length, 3, 'private evidence baseline must still contain exactly 3 reviewed hashes');

  for (const png of expectedPngs) {
    assert.ok(fs.existsSync(png), `${png} must exist`);
    const sha256 = computeFileSha256Sync(png);
    assert.ok(REVIEWED_BINARY_SHAS.has(sha256), `${png} SHA ${sha256} must be in allowlist`);
    assert.equal(checkBinaryFile(sha256, png), null, 'reviewed binary must pass check');
  }

  // Any modified or unknown binary fails closed
  const fakeBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x99, 0x88]);
  const unknownFinding = checkBinaryFile(fakeBinary, 'unknown.png');
  assert.ok(unknownFinding, 'unreviewed binary must fail closed');
  assert.equal(unknownFinding.category, 'manual_review_required');
});
