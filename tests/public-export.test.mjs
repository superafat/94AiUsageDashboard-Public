import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { auditPublicTree } from '../scripts/audit-public-release.mjs';
import {
  exportPublicRelease,
  auditExportDirectory,
  generateManifest,
  filterExportFiles,
  isUnsafeExportDirectory,
  DEFAULT_EXCLUDE_PATTERNS,
} from '../scripts/export-public-release.mjs';

function isGitWorktree(cwd) {
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    return false;
  }
  try {
    const res = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    return res === 'true';
  } catch {
    return false;
  }
}

function setupSyntheticRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-repo-'));
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: tmpDir, stdio: 'pipe', encoding: 'utf8' });

  run('git', ['init']);
  run('git', ['config', 'user.name', 'Export Test User']);
  run('git', ['config', 'user.email', ['export-tester', 'example.com'].join('@')]);

  // Tracked clean files
  fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test-pkg", "version": "0.1.2"}\n');
  fs.writeFileSync(path.join(tmpDir, '.env.example'), 'VITE_FIREBASE_PROJECT_ID=demo-project\n');
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Public Readme\n');
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src/index.ts'), 'export const hello = "world";\n');

  // Tracked files that should be excluded by policy
  fs.mkdirSync(path.join(tmpDir, 'docs/superpowers/plans'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'docs/superpowers/plans/plan.md'), '# Internal Plan\n');
  fs.mkdirSync(path.join(tmpDir, 'docs/evidence'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'docs/evidence/inventory.md'), '# Internal Evidence\n');

  run('git', ['add', '-f', '.']);
  run('git', ['commit', '-m', 'initial commit']);

  // Untracked / ignored files that must NEVER be copied
  fs.writeFileSync(path.join(tmpDir, '.env.local'), 'PRIVATE_KEY=should_never_copy\n');
  fs.mkdirSync(path.join(tmpDir, 'node_modules/fake-pkg'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'node_modules/fake-pkg/index.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(tmpDir, 'firestore-debug.log'), 'debug log content\n');
  fs.mkdirSync(path.join(tmpDir, '.superpowers'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.superpowers/ledger.json'), '{"ledger": true}\n');

  return {
    tmpDir,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

test('exportPublicRelease refuses to export and fails closed when current tree audit has blockers', () => {
  const repo = setupSyntheticRepo();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-out-'));
  try {
    // Add a tracked file containing a blocker (real secret pattern)
    const fakeKey = 'AIza' + 'SySyntheticCanaryLiveKey1234567890X';
    fs.writeFileSync(path.join(repo.tmpDir, 'secret.txt'), `apiKey: "${fakeKey}"\n`);
    execFileSync('git', ['add', 'secret.txt'], { cwd: repo.tmpDir });
    execFileSync('git', ['commit', '-m', 'add secret file'], { cwd: repo.tmpDir });

    assert.throws(
      () => exportPublicRelease({ cwd: repo.tmpDir, outDir }),
      /Export blocked: source tree audit found/i,
      'must throw when source tree has blockers',
    );

    // Ensure outDir remains empty or is cleaned up
    const files = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
    assert.equal(files.length, 0, 'outDir must not contain any exported files on blocker');
  } finally {
    repo.cleanup();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('exportPublicRelease derives ONLY from git ls-files and never copies untracked or ignored developer files', () => {
  const repo = setupSyntheticRepo();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-out-'));
  try {
    const result = exportPublicRelease({ cwd: repo.tmpDir, outDir });
    assert.equal(result.success, true);

    // Untracked developer files must NOT exist in outDir
    assert.ok(!fs.existsSync(path.join(outDir, '.env.local')), '.env.local must not be exported');
    assert.ok(!fs.existsSync(path.join(outDir, 'node_modules')), 'node_modules must not be exported');
    assert.ok(!fs.existsSync(path.join(outDir, 'firestore-debug.log')), 'firestore-debug.log must not be exported');
    assert.ok(!fs.existsSync(path.join(outDir, '.superpowers')), '.superpowers must not be exported');
    assert.ok(!fs.existsSync(path.join(outDir, '.git')), '.git must not be exported');
  } finally {
    repo.cleanup();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('exportPublicRelease excludes private evidence, plans, and internal superpowers docs', () => {
  const repo = setupSyntheticRepo();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-out-'));
  try {
    const result = exportPublicRelease({ cwd: repo.tmpDir, outDir });
    assert.equal(result.success, true);

    // Tracked internal docs must be excluded by policy
    assert.ok(!fs.existsSync(path.join(outDir, 'docs/superpowers')), 'docs/superpowers must be excluded');
    assert.ok(!fs.existsSync(path.join(outDir, 'docs/evidence')), 'docs/evidence must be excluded');

    // Clean public files must be included
    assert.ok(fs.existsSync(path.join(outDir, 'package.json')), 'package.json must be included');
    assert.ok(fs.existsSync(path.join(outDir, '.env.example')), '.env.example must be included');
    assert.ok(fs.existsSync(path.join(outDir, 'README.md')), 'README.md must be included');
    assert.ok(fs.existsSync(path.join(outDir, 'src/index.ts')), 'src/index.ts must be included');
  } finally {
    repo.cleanup();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('filterExportFiles enforces DEFAULT_EXCLUDE_PATTERNS deterministically', () => {
  assert.ok(DEFAULT_EXCLUDE_PATTERNS.length >= 8, 'must provide comprehensive exclude patterns');

  const candidates = [
    'package.json',
    '.env.example',
    '.env.local',
    '.env',
    '.git/config',
    '.superpowers/ledger.json',
    'docs/superpowers/plans/task.md',
    'docs/evidence/inventory.md',
    'docs/getting-started.md',
    'apps/agent/src/cli.ts',
    'firebase-debug.log',
    'node_modules/pkg/index.js',
    'coverage/lcov.info',
    'test-results/summary.json',
  ];

  const filtered = filterExportFiles(candidates);
  assert.deepEqual(filtered, [
    'package.json',
    '.env.example',
    'docs/getting-started.md',
    'apps/agent/src/cli.ts',
  ]);
});

test('generateManifest produces deterministic sorted file hashes with source commit', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'content b\n');
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'content a\n');

    const commitSha = '1234567890abcdef1234567890abcdef12345678';
    const { manifestPath, manifestContent } = generateManifest(tmpDir, ['b.txt', 'a.txt'], commitSha);

    assert.ok(fs.existsSync(manifestPath));
    const lines = manifestContent.trim().split('\n');
    assert.equal(lines[0], `# source_commit: ${commitSha}`);
    assert.match(lines[1], /^[0-9a-f]{64} {2}a\.txt$/);
    assert.match(lines[2], /^[0-9a-f]{64} {2}b\.txt$/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('exportPublicRelease generates deterministic PUBLIC_EXPORT_MANIFEST.sha256 with commit SHA and file hashes without ambiguity', () => {
  const repo = setupSyntheticRepo();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-out-'));
  try {
    const result = exportPublicRelease({ cwd: repo.tmpDir, outDir });
    assert.equal(result.success, true);
    const manifestPath = path.join(outDir, 'PUBLIC_EXPORT_MANIFEST.sha256');

    assert.ok(fs.existsSync(manifestPath), 'PUBLIC_EXPORT_MANIFEST.sha256 must exist');
    const content = fs.readFileSync(manifestPath, 'utf8');
    const lines = content.trim().split('\n');

    // First line must contain source commit SHA
    assert.match(lines[0], /^# source_commit: [0-9a-f]{40}$/i, 'first line must record source commit SHA');

    // Remaining lines must be sha256 + space space + path
    const fileEntries = lines.slice(1);
    assert.ok(fileEntries.length > 0, 'must have file hash entries');

    const filePaths = [];
    for (const line of fileEntries) {
      assert.match(line, /^[0-9a-f]{64} {2}.+$/, 'line must be 64-char sha256 followed by two spaces and path');
      const [, filePath] = line.split('  ');
      filePaths.push(filePath);

      // Verify no self-referential manifest entry
      assert.notEqual(filePath, 'PUBLIC_EXPORT_MANIFEST.sha256', 'manifest must not list itself');

      // Verify SHA matches actual file on disk
      const fullPath = path.join(outDir, filePath);
      assert.ok(fs.existsSync(fullPath), `exported file ${filePath} must exist on disk`);
      const fileBytes = fs.readFileSync(fullPath);
      const expectedHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
      assert.equal(line.slice(0, 64), expectedHash, `hash in manifest must match actual file hash for ${filePath}`);
    }

    // Must be sorted deterministically
    const sortedPaths = [...filePaths].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(filePaths, sortedPaths, 'file entries in manifest must be sorted lexicographically');

    // Running export again produces identical manifest content
    const outDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'export-out2-'));
    try {
      const result2 = exportPublicRelease({ cwd: repo.tmpDir, outDir: outDir2 });
      assert.equal(result2.success, true);
      const content2 = fs.readFileSync(path.join(outDir2, 'PUBLIC_EXPORT_MANIFEST.sha256'), 'utf8');
      assert.equal(content, content2, 'manifest content must be completely deterministic');
    } finally {
      fs.rmSync(outDir2, { recursive: true, force: true });
    }
  } finally {
    repo.cleanup();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('auditExportDirectory audits non-git exported tree using policy and fails closed if blocker appears', () => {
  const repo = setupSyntheticRepo();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-out-'));
  try {
    exportPublicRelease({ cwd: repo.tmpDir, outDir });

    // The export directory is NOT a git repo
    assert.ok(!fs.existsSync(path.join(outDir, '.git')), 'export directory is intentionally not a git repo');

    // Clean export directory has zero findings
    const initialFindings = auditExportDirectory(outDir);
    assert.equal(initialFindings.length, 0, 'clean export directory must have 0 findings');

    // Injecting a sensitive file into the exported directory triggers auditExportDirectory
    const fakeSecret = 'AIza' + 'SySyntheticCanaryLiveKey1234567890X';
    fs.writeFileSync(path.join(outDir, 'leaked.txt'), `secret: "${fakeSecret}"\n`);

    const findingsAfterLeak = auditExportDirectory(outDir);
    const blocker = findingsAfterLeak.find((f) => f.category === 'secret');
    assert.ok(blocker, 'auditExportDirectory must detect secret in non-git export');
    assert.equal(blocker.severity, 'BLOCKER');

    // Injecting a local home path triggers blocker (assembled to avoid static canary match)
    const localHomeVal = ['/Users', 'alice', 'project'].join('/');
    fs.writeFileSync(path.join(outDir, 'path.txt'), `path: "${localHomeVal}"\n`);
    const findingsAfterPath = auditExportDirectory(outDir);
    assert.ok(findingsAfterPath.some((f) => f.category === 'local_home_path'), 'must detect local home path');
  } finally {
    repo.cleanup();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('auditPublicTree fail-closed non-git behavior is strictly preserved', () => {
  const tmpNonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'nongit-check-'));
  try {
    fs.writeFileSync(path.join(tmpNonGit, 'file.txt'), 'hello\n');
    assert.throws(
      () => auditPublicTree(tmpNonGit),
      /Not a git repository/i,
      'auditPublicTree must continue throwing on non-git directory',
    );
  } finally {
    fs.rmSync(tmpNonGit, { recursive: true, force: true });
  }
});

test('package.json defines export:public script and current workspace exports clean public release', (t) => {
  const rootPkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(rootPkg.scripts?.['export:public'], 'node scripts/export-public-release.mjs');

  if (!isGitWorktree(process.cwd())) {
    t.skip('Skipping live workspace export test when running inside a non-Git exported release directory');
    return;
  }

  const defaultOutDir = '/tmp/94aiusage-v0.1.2-public';
  // Export current tree
  const result = exportPublicRelease({ cwd: process.cwd(), outDir: defaultOutDir });
  assert.equal(result.success, true);
  assert.equal(result.outDir, defaultOutDir);
  assert.ok(result.exportedFilesCount > 50, 'must export full project files');

  // Verify manifest exists and is valid
  const manifestPath = path.join(defaultOutDir, 'PUBLIC_EXPORT_MANIFEST.sha256');
  assert.ok(fs.existsSync(manifestPath), 'PUBLIC_EXPORT_MANIFEST.sha256 must exist in default export');

  // Verify critical files are present
  assert.ok(fs.existsSync(path.join(defaultOutDir, 'package.json')), 'package.json must be present');
  assert.ok(fs.existsSync(path.join(defaultOutDir, 'package-lock.json')), 'package-lock.json must be present');
  assert.ok(fs.existsSync(path.join(defaultOutDir, '.env.example')), '.env.example must be present');
  assert.ok(fs.existsSync(path.join(defaultOutDir, 'README.md')), 'README.md must be present');
  assert.ok(fs.existsSync(path.join(defaultOutDir, 'LICENSE')), 'LICENSE must be present');
  assert.ok(fs.existsSync(path.join(defaultOutDir, 'AI_INSTALL.md')), 'AI_INSTALL.md must be present');
  assert.ok(fs.existsSync(path.join(defaultOutDir, 'SECURITY.md')), 'SECURITY.md must be present');
  assert.ok(fs.existsSync(path.join(defaultOutDir, 'docs/getting-started.md')), 'getting-started.md must be present');
  assert.ok(fs.existsSync(path.join(defaultOutDir, 'apps/agent/src/cli.ts')), 'apps/agent source must be present');
  assert.ok(fs.existsSync(path.join(defaultOutDir, 'apps/web/src/main.tsx')), 'apps/web source must be present');

  // Verify excluded items are ABSENT
  assert.ok(!fs.existsSync(path.join(defaultOutDir, '.git')), '.git must be absent');
  assert.ok(!fs.existsSync(path.join(defaultOutDir, '.superpowers')), '.superpowers must be absent');
  assert.ok(!fs.existsSync(path.join(defaultOutDir, 'docs/superpowers')), 'docs/superpowers must be absent');
  assert.ok(!fs.existsSync(path.join(defaultOutDir, 'docs/evidence')), 'docs/evidence must be absent');
  assert.ok(!fs.existsSync(path.join(defaultOutDir, '.env.local')), '.env.local must be absent');
});

test('exportPublicRelease refuses to export to system temp root /tmp, os.tmpdir(), root, homedir, or repo cwd', () => {
  const repo = setupSyntheticRepo();
  try {
    assert.throws(
      () => exportPublicRelease({ cwd: repo.tmpDir, outDir: '/tmp' }),
      /Refusing to export to unsafe directory/i,
      'must refuse to export to /tmp',
    );
    assert.throws(
      () => exportPublicRelease({ cwd: repo.tmpDir, outDir: os.tmpdir() }),
      /Refusing to export to unsafe directory/i,
      'must refuse to export to os.tmpdir()',
    );
    assert.throws(
      () => exportPublicRelease({ cwd: repo.tmpDir, outDir: '/' }),
      /Refusing to export to unsafe directory/i,
      'must refuse to export to root /',
    );
    assert.throws(
      () => exportPublicRelease({ cwd: repo.tmpDir, outDir: os.homedir() }),
      /Refusing to export to unsafe directory/i,
      'must refuse to export to homedir',
    );
    assert.throws(
      () => exportPublicRelease({ cwd: repo.tmpDir, outDir: repo.tmpDir }),
      /Refusing to export to unsafe directory/i,
      'must refuse to export to current repo directory',
    );
  } finally {
    repo.cleanup();
  }
});

test('isUnsafeExportDirectory accurately classifies unsafe system roots vs safe subdirectories', () => {
  assert.equal(isUnsafeExportDirectory('/tmp'), true);
  assert.equal(isUnsafeExportDirectory(os.tmpdir()), true);
  assert.equal(isUnsafeExportDirectory('/'), true);
  assert.equal(isUnsafeExportDirectory(os.homedir()), true);
  assert.equal(isUnsafeExportDirectory('/tmp/nonexistent-subpath-test'), false);
  assert.equal(isUnsafeExportDirectory(path.join(os.tmpdir(), 'valid-export-subfolder')), false);
});

test('auditExportDirectory refuses to audit unsafe system root, homedir, or temp root', () => {
  assert.throws(
    () => auditExportDirectory('/tmp'),
    /Refusing to audit unsafe directory/i,
  );
  assert.throws(
    () => auditExportDirectory(os.tmpdir()),
    /Refusing to audit unsafe directory/i,
  );
  assert.throws(
    () => auditExportDirectory('/'),
    /Refusing to audit unsafe directory/i,
  );
  assert.throws(
    () => auditExportDirectory(os.homedir()),
    /Refusing to audit unsafe directory/i,
  );
});

test('exportPublicRelease fails closed when source directory is not a git repository', () => {
  const tmpNonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'nongit-export-src-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nongit-export-out-'));
  try {
    assert.throws(
      () => exportPublicRelease({ cwd: tmpNonGit, outDir }),
      /Not a git repository/i,
      'exportPublicRelease must fail closed when cwd is not a git repo',
    );
  } finally {
    fs.rmSync(tmpNonGit, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('non-Git exported npm test path does not fail solely because source-repo-only test cannot run', () => {
  const tmpNonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'nongit-export-runner-'));
  const repo = setupSyntheticRepo();
  try {
    assert.equal(isGitWorktree(tmpNonGit), false, 'non-git dir must not be classified as git worktree');
    assert.equal(isGitWorktree(repo.tmpDir), true, 'git repository must be classified as git worktree');

    const testFile = fileURLToPath(import.meta.url);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;

    const output = execFileSync(
      process.execPath,
      ['--test', '--test-name-pattern=defines export:public script', testFile],
      {
        cwd: tmpNonGit,
        env,
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );
    assert.match(output, /# skip/i, 'should report the test as skipped in non-git directory');
    assert.doesNotMatch(output, /fail [1-9]/, 'must have zero failures in non-git directory');
  } finally {
    repo.cleanup();
    fs.rmSync(tmpNonGit, { recursive: true, force: true });
  }
});



test('exportPublicRelease refuses dirty working trees so manifest provenance cannot lie', () => {
  const repo = setupSyntheticRepo();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-dirty-'));
  try {
    fs.writeFileSync(path.join(repo.tmpDir, 'README.md'), '# uncommitted change\n');
    assert.throws(() => exportPublicRelease({ cwd: repo.tmpDir, outDir }), /working tree.*clean|uncommitted|dirty/i);
  } finally {
    repo.cleanup();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('exportPublicRelease preserves non-ASCII tracked paths exactly', () => {
  const repo = setupSyntheticRepo();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-unicode-'));
  try {
    const relPath = '文件/說明.md';
    fs.mkdirSync(path.join(repo.tmpDir, '文件'), { recursive: true });
    fs.writeFileSync(path.join(repo.tmpDir, relPath), '# safe unicode file\n');
    execFileSync('git', ['add', relPath], { cwd: repo.tmpDir });
    execFileSync('git', ['commit', '-m', 'add unicode file'], { cwd: repo.tmpDir });
    const result = exportPublicRelease({ cwd: repo.tmpDir, outDir });
    assert.equal(result.success, true);
    assert.ok(fs.existsSync(path.join(outDir, relPath)));
  } finally {
    repo.cleanup();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('exportPublicRelease removes partial output when copying throws', () => {
  const repo = setupSyntheticRepo();
  const outDir = path.join(os.tmpdir(), `export-partial-${Date.now()}`);
  let calls = 0;
  try {
    assert.throws(() => exportPublicRelease({
      cwd: repo.tmpDir,
      outDir,
      copyFileSync: (src, dest) => {
        calls += 1;
        if (calls === 2) throw new Error('synthetic copy failure');
        fs.copyFileSync(src, dest);
      },
    }), /synthetic copy failure/);
    assert.equal(fs.existsSync(outDir), false, 'partial export directory must be cleaned');
  } finally {
    repo.cleanup();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
