import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { auditPublicTree, auditGitHistory } from '../scripts/audit-public-release.mjs';
import { computeSha256 } from '../scripts/public-release-policy.mjs';

function setupSyntheticRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-repo-'));
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: tmpDir, stdio: 'pipe', encoding: 'utf8' });

  run('git', ['init']);
  run('git', ['config', 'user.name', 'Synthetic Canary Tester']);
  run('git', ['config', 'user.email', ['synthetic-tester', 'example.com'].join('@')]);

  const FAKE_ACTIVE_KEY = 'AIza' + 'SySyntheticCanaryLiveKey1234567890X';
  const FAKE_DELETED_SECRET = 'ghp_' + 'SyntheticCanaryDeletedToken1234567890';
  const FAKE_LOCAL_PATH = ['/Users', 'example', 'secret-project'].join('/');
  const FAKE_EMAIL = ['synthetic.canary.dev', 'example.org'].join('@');
  const FAKE_FIREBASE_MARKER = 'https://' + 'synthetic-canary-prod-db.' + 'firebaseio.com';
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

  // Commit 1: Add tracked files with canaries
  fs.writeFileSync(path.join(tmpDir, 'active-key.txt'), `apiKey: "${FAKE_ACTIVE_KEY}"\n`);
  fs.writeFileSync(path.join(tmpDir, 'deleted-secret.txt'), `secretToken: "${FAKE_DELETED_SECRET}"\n`);
  fs.writeFileSync(path.join(tmpDir, 'local-path.txt'), `workspace: "${FAKE_LOCAL_PATH}/sub"\n`);
  fs.writeFileSync(path.join(tmpDir, 'contact.txt'), `contact: "${FAKE_EMAIL}"\n`);
  fs.writeFileSync(path.join(tmpDir, 'firebase-config.json'), `{"databaseUrl": "${FAKE_FIREBASE_MARKER}"}\n`);
  fs.writeFileSync(path.join(tmpDir, '.env.local'), 'PRIVATE_VAR=foo\n');
  fs.writeFileSync(path.join(tmpDir, 'canary.png'), PNG_BYTES);
  fs.writeFileSync(path.join(tmpDir, 'clean.txt'), 'clean public text\n');

  run('git', ['add', '-f', '.']);
  run('git', ['commit', '-m', 'commit-1: add canaries']);

  // Commit 2: Delete deleted-secret.txt
  run('git', ['rm', 'deleted-secret.txt']);
  run('git', ['commit', '-m', 'commit-2: remove secret']);

  return {
    tmpDir,
    canaries: {
      FAKE_ACTIVE_KEY,
      FAKE_DELETED_SECRET,
      FAKE_LOCAL_PATH,
      FAKE_EMAIL,
      FAKE_FIREBASE_MARKER,
      PNG_BYTES,
    },
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failure in test
      }
    },
  };
}

test('auditPublicTree detects candidate violations in tree and skips deleted files', () => {
  const repo = setupSyntheticRepo();
  try {
    const findings = auditPublicTree(repo.tmpDir);

    // Should find: active key, local path, email, firebase marker, .env.local, canary.png
    const categories = findings.map((f) => f.category);
    assert.ok(categories.includes('secret'), 'must detect active secret');
    assert.ok(categories.includes('local_home_path'), 'must detect local home path');
    assert.ok(categories.includes('email_address'), 'must detect email address');
    assert.ok(categories.includes('private_firebase_marker'), 'must detect private firebase marker');
    assert.ok(categories.includes('credential_filename'), 'must detect credential filename');
    assert.ok(categories.includes('manual_review_required'), 'must detect unreviewed binary file');

    // Should NOT find deleted secret in tree audit
    const paths = findings.map((f) => f.path);
    assert.ok(!paths.includes('deleted-secret.txt'), 'tree audit must not report deleted file');

    // All findings have severity BLOCKER and detail
    for (const f of findings) {
      assert.equal(f.severity, 'BLOCKER');
      assert.ok(typeof f.detail === 'string' && f.detail.length > 0);
      assert.ok(typeof f.path === 'string' && f.path.length > 0);
    }
  } finally {
    repo.cleanup();
  }
});

test('auditGitHistory detects deleted historical secrets across reachable blobs', () => {
  const repo = setupSyntheticRepo();
  try {
    const findings = auditGitHistory(repo.tmpDir);

    // Must find deleted-secret.txt from historical commit
    const deletedSecretFinding = findings.find(
      (f) => f.path === 'deleted-secret.txt' && f.category === 'secret',
    );
    assert.ok(deletedSecretFinding, 'history audit must find deleted secret');
    assert.ok(typeof deletedSecretFinding.commit === 'string', 'history finding must contain commit SHA');
    assert.match(deletedSecretFinding.commit, /^[0-9a-f]{40}$/i, 'commit must be a 40-char SHA');
    const introductionCommit = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: repo.tmpDir, encoding: 'utf8' }).trim();
    assert.equal(deletedSecretFinding.commit, introductionCommit, 'history provenance must point to the blob introduction commit');
  } finally {
    repo.cleanup();
  }
});

test('findings NEVER echo secret or canary values in detail or JSON output', () => {
  const repo = setupSyntheticRepo();
  try {
    const treeFindings = auditPublicTree(repo.tmpDir);
    const historyFindings = auditGitHistory(repo.tmpDir);
    const allFindings = [...treeFindings, ...historyFindings];

    const secretValues = [
      repo.canaries.FAKE_ACTIVE_KEY,
      repo.canaries.FAKE_DELETED_SECRET,
      repo.canaries.FAKE_LOCAL_PATH,
      repo.canaries.FAKE_EMAIL,
      repo.canaries.FAKE_FIREBASE_MARKER,
    ];

    // Check every detail field
    for (const f of allFindings) {
      for (const secret of secretValues) {
        assert.ok(
          !f.detail.includes(secret),
          `finding detail leaked sensitive value '${secret}' in ${f.path}`,
        );
      }
    }

    // Check JSON serialization
    const jsonOutput = JSON.stringify(allFindings);
    for (const secret of secretValues) {
      assert.ok(
        !jsonOutput.includes(secret),
        `serialized JSON leaked sensitive value '${secret}'`,
      );
    }
  } finally {
    repo.cleanup();
  }
});

test('binary files fail closed unless exact SHA-256 is explicitly allowlisted', () => {
  const repo = setupSyntheticRepo();
  try {
    const hash = computeSha256(repo.canaries.PNG_BYTES);

    // Unreviewed binary produces manual_review_required
    const unreviewed = auditPublicTree(repo.tmpDir);
    const pngFinding = unreviewed.find((f) => f.path === 'canary.png');
    assert.ok(pngFinding, 'unreviewed binary must produce finding');
    assert.equal(pngFinding.category, 'manual_review_required');
    assert.ok(pngFinding.detail.includes(hash), 'detail must record SHA-256 for review');

    // Allowlisted binary produces NO finding
    const reviewed = auditPublicTree(repo.tmpDir, {
      reviewedBinaries: new Set([hash]),
    });
    const reviewedPngFinding = reviewed.find((f) => f.path === 'canary.png');
    assert.equal(reviewedPngFinding, undefined, 'allowlisted binary must not produce finding');
  } finally {
    repo.cleanup();
  }
});

test('ignored developer secrets are out of scope and never opened by tree audit', () => {
  const repo = setupSyntheticRepo();
  try {
    // Add an ignored local file that is NOT tracked in git
    fs.writeFileSync(path.join(repo.tmpDir, '.gitignore'), '.env*.local\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: repo.tmpDir });
    execFileSync('git', ['commit', '-m', 'add gitignore'], { cwd: repo.tmpDir });

    const ignoredSecret = 'AIza' + 'SyIgnoredWorkingMachineSecret12345';
    fs.writeFileSync(path.join(repo.tmpDir, '.env.secret.local'), `SECRET=${ignoredSecret}\n`);

    const findings = auditPublicTree(repo.tmpDir);
    const foundIgnored = findings.find((f) => f.path.includes('.env.secret.local'));
    assert.equal(foundIgnored, undefined, 'untracked ignored file must not be scanned');
  } finally {
    repo.cleanup();
  }
});

test('package.json exposes audit:public and CLI supports --json output without leaks', () => {
  const rootPkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(rootPkg.scripts?.['audit:public'], 'node scripts/audit-public-release.mjs');

  const repo = setupSyntheticRepo();
  try {
    const cliScript = path.resolve('scripts/audit-public-release.mjs');
    let stdout = '';
    let status = 0;
    try {
      stdout = execFileSync(
        'node',
        [cliScript, '--json', '--cwd', repo.tmpDir],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (err) {
      status = err.status;
      stdout = err.stdout;
    }

    // Must exit with non-zero status because findings exist
    assert.equal(status, 1, 'CLI must exit with code 1 on findings');

    // Output must be parseable JSON array
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed), 'CLI --json output must be an array of findings');
    assert.ok(parsed.length > 0, 'CLI must report findings');

    // Check no sensitive canary values appear in CLI output
    for (const secret of Object.values(repo.canaries)) {
      if (typeof secret === 'string') {
        assert.ok(!stdout.includes(secret), `CLI output leaked canary value '${secret}'`);
      }
    }
  } finally {
    repo.cleanup();
  }
});

test('files and blobs exceeding maxSizeBytes fail closed and do not silently pass', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-maxsize-repo-'));
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: tmpDir, stdio: 'pipe', encoding: 'utf8' });

  try {
    run('git', ['init']);
    run('git', ['config', 'user.name', 'Tester']);
    run('git', ['config', 'user.email', ['tester', 'example.com'].join('@')]);

    // Create a 5KB text file, a 5KB PNG file, a 5KB credential file, and a 6KB deleted PNG
    const largeText = 'A'.repeat(5000);
    const largePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5000)]);
    const deletedLargePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(6000)]);
    const largeCred = Buffer.alloc(5000, 0x20);

    fs.writeFileSync(path.join(tmpDir, 'large-doc.txt'), largeText);
    fs.writeFileSync(path.join(tmpDir, 'large.png'), largePng);
    fs.writeFileSync(path.join(tmpDir, 'large-creds.p12'), largeCred);
    fs.writeFileSync(path.join(tmpDir, 'deleted-large.png'), deletedLargePng);

    run('git', ['add', '-f', '.']);
    run('git', ['commit', '-m', 'add large files']);

    // Commit 2: delete deleted-large.png
    run('git', ['rm', 'deleted-large.png']);
    run('git', ['commit', '-m', 'delete large binary']);

    // Test with maxSizeBytes: 2000 (2KB limit)
    const treeFindings = auditPublicTree(tmpDir, { maxSizeBytes: 2000 });
    const paths = treeFindings.map((f) => f.path);

    // 1. large-doc.txt (> 2KB) must NOT silently pass; must fail closed as BLOCKER manual_review_required
    assert.ok(paths.includes('large-doc.txt'), 'large text file must fail closed');
    const docFinding = treeFindings.find((f) => f.path === 'large-doc.txt');
    assert.equal(docFinding.severity, 'BLOCKER');
    assert.equal(docFinding.category, 'manual_review_required');

    // 2. large-creds.p12 (> 2KB) must be flagged for credential filename
    assert.ok(paths.includes('large-creds.p12'), 'large credential file must be flagged');
    const credFinding = treeFindings.find((f) => f.path === 'large-creds.p12' && f.category === 'credential_filename');
    assert.ok(credFinding, 'credential filename check must run on large files');

    // 3. large.png (> 2KB) must be flagged for unreviewed binary
    assert.ok(paths.includes('large.png'), 'large unreviewed binary must fail closed');
    const pngFinding = treeFindings.find((f) => f.path === 'large.png' && f.category === 'manual_review_required');
    assert.ok(pngFinding, 'large binary must require manual review');

    // 4. In Git history: deleted-large.png (> 2KB) must fail closed as manual_review_required
    const historyFindings = auditGitHistory(tmpDir, { maxSizeBytes: 2000 });
    const historyDeletedPng = historyFindings.find((f) => f.path === 'deleted-large.png' && f.category === 'manual_review_required');
    assert.ok(historyDeletedPng, 'historical large binary must fail closed');
    assert.equal(historyDeletedPng.severity, 'BLOCKER');

    // 5. If large.png SHA-256 is explicitly allowlisted, large.png passes review
    const pngHash = computeSha256(largePng);
    const reviewedTree = auditPublicTree(tmpDir, { maxSizeBytes: 2000, reviewedBinaries: new Set([pngHash]) });
    const reviewedPng = reviewedTree.find((f) => f.path === 'large.png');
    assert.equal(reviewedPng, undefined, 'allowlisted large binary passes review');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('git rev-list and git cat-file failures fail closed and never return empty safe results', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fail-git-'));
  try {
    assert.throws(
      () => auditGitHistory(tmpDir),
      /Not a git repository/i,
      'auditGitHistory must throw on non-git directory',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('non-git directory fails closed and never walks local filesystem', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-nongit-'));
  try {
    fs.writeFileSync(path.join(tmpDir, '.env.local'), 'SECRET=should_never_be_opened\n');
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello\n');

    assert.throws(
      () => auditPublicTree(tmpDir),
      /Not a git repository/i,
      'auditPublicTree must throw on non-git directory instead of walking files',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('tracked symlinks are inspected via lstat and never dereferenced outside repository', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-symlink-repo-'));
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: tmpDir, stdio: 'pipe', encoding: 'utf8' });

  try {
    run('git', ['init']);
    run('git', ['config', 'user.name', 'Tester']);
    run('git', ['config', 'user.email', ['tester', 'example.com'].join('@')]);

    // 1. External symlink pointing outside repo
    fs.symlinkSync('/etc/hosts', path.join(tmpDir, 'external-link'));

    // 2. Symlink with credential filename pointing to an internal file
    fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'normal content\n');
    fs.symlinkSync('dummy.txt', path.join(tmpDir, 'credentials.json'));

    // 3. Symlink target with local home path
    fs.symlinkSync(['/Users', 'someone', 'secret', 'path'].join('/'), path.join(tmpDir, 'local-home-link'));

    // 4. Broken symlink
    fs.symlinkSync('non-existent-target.txt', path.join(tmpDir, 'broken-link'));

    run('git', ['add', '-f', '.']);
    run('git', ['commit', '-m', 'add symlinks']);

    const findings = auditPublicTree(tmpDir);

    // External symlink must fail closed
    const extFinding = findings.find((f) => f.path === 'external-link');
    assert.ok(extFinding, 'external symlink must produce finding');
    assert.equal(extFinding.severity, 'BLOCKER');

    // Symlink with credential filename must produce credential_filename finding
    const credFinding = findings.find((f) => f.path === 'credentials.json' && f.category === 'credential_filename');
    assert.ok(credFinding, 'credential-named symlink must produce credential_filename finding');

    // Symlink with local home target must produce local_home_path finding
    const homeFinding = findings.find((f) => f.path === 'local-home-link' && f.category === 'local_home_path');
    assert.ok(homeFinding, 'local home symlink must produce local_home_path finding');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});




test('auditPublicTree fails closed when a tracked path cannot be inspected', () => {
  const repo = setupSyntheticRepo();
  try {
    fs.unlinkSync(path.join(repo.tmpDir, 'clean.txt'));
    const findings = auditPublicTree(repo.tmpDir);
    const finding = findings.find((f) => f.path === 'clean.txt' && f.category === 'manual_review_required');
    assert.ok(finding, 'missing tracked file must become a blocker');
    assert.equal(finding.severity, 'BLOCKER');
  } finally {
    repo.cleanup();
  }
});

test('tree audit preserves non-ASCII Git paths and inspects their content', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-unicode-'));
  const run = (args) => execFileSync('git', args, { cwd: tmpDir, stdio: 'pipe', encoding: 'utf8' });
  try {
    run(['init']);
    run(['config', 'user.name', 'Unicode Audit']);
    run(['config', 'user.email', ['unicode-audit', 'example.com'].join('@')]);
    const relPath = '測試資料/額度檔案.md';
    fs.mkdirSync(path.join(tmpDir, '測試資料'), { recursive: true });
    const syntheticHome = ['/Users', 'example', 'private'].join('/');
    fs.writeFileSync(path.join(tmpDir, relPath), `workspace: ${syntheticHome}\n`);
    run(['add', '.']);
    run(['commit', '-m', 'unicode path canary']);
    const finding = auditPublicTree(tmpDir).find((f) => f.path === relPath && f.category === 'local_home_path');
    assert.ok(finding, 'non-ASCII path must be audited under its exact name');
    const historyFinding = auditGitHistory(tmpDir).find((f) => f.path === relPath && f.category === 'local_home_path');
    assert.ok(historyFinding, 'history audit must preserve and inspect the exact non-ASCII path');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
