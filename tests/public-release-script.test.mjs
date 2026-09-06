import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

const ROOT_DIR = process.cwd();

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

test('package.json defines verify:public-release script', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['verify:public-release'],
    'node scripts/verify-public-release.mjs',
    'package.json must define verify:public-release script',
  );
  assert.equal(
    pkg.scripts['verify:public-ready'],
    'node scripts/verify-public-ready.mjs',
    'package.json must preserve verify:public-ready script',
  );
});

test('.github/workflows/ci.yml wires verify:public-release into CI workflow on pull requests and main with --skip-public-ready', () => {
  const workflow = fs.readFileSync(path.join(ROOT_DIR, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /npm run verify:public-release -- --skip-public-ready/, 'ci.yml must run verify:public-release with --skip-public-ready to avoid double execution');
  assert.match(workflow, /npm run verify:public-ready/, 'ci.yml must maintain verify:public-ready compatibility');
  assert.doesNotMatch(workflow, /npm run verify:public-release\s*$/, 'ci.yml must not run bare verify:public-release without --skip-public-ready');
  assert.match(workflow, /push:\s*\n\s*branches:\s*\[main\]/, 'workflow must trigger on push to main');
  assert.match(workflow, /pull_request:/, 'workflow must trigger on pull_request');
});

test('scripts/verify-public-release.mjs exists and exports canonical API, parseArgs, and reviewed history baseline', async () => {
  const scriptPath = path.join(ROOT_DIR, 'scripts/verify-public-release.mjs');
  assert.ok(fs.existsSync(scriptPath), 'scripts/verify-public-release.mjs must exist');

  const mod = await import(`file://${scriptPath}`);
  assert.equal(typeof mod.verifyPublicRelease, 'function', 'must export verifyPublicRelease');
  assert.equal(typeof mod.checkHistoryAgainstBaseline, 'function', 'must export checkHistoryAgainstBaseline');
  assert.equal(typeof mod.matchesBaseline, 'function', 'must export matchesBaseline');
  assert.equal(typeof mod.parseArgs, 'function', 'must export parseArgs');
  assert.ok(Array.isArray(mod.REVIEWED_HISTORY_BASELINE), 'must export REVIEWED_HISTORY_BASELINE array');
  const privateBaselinePath = path.join(ROOT_DIR, 'docs/evidence/v0.1.2-private-release-baseline.json');
  if (fs.existsSync(privateBaselinePath)) {
    assert.ok(mod.REVIEWED_HISTORY_BASELINE.length > 0, 'private engineering repo must load reviewed history baseline');
  } else {
    assert.equal(mod.REVIEWED_HISTORY_BASELINE.length, 0, 'clean public repo must not carry private history baseline');
  }
});



test('public release scripts do not embed private baseline identifiers', async () => {
  const verifierPath = path.join(ROOT_DIR, 'scripts/verify-public-release.mjs');
  const policyPath = path.join(ROOT_DIR, 'scripts/public-release-policy.mjs');
  const verifierContent = fs.readFileSync(verifierPath, 'utf8');
  const policyContent = fs.readFileSync(policyPath, 'utf8');
  const verifier = await import(`file://${verifierPath}`);
  const policy = await import(`file://${policyPath}`);

  for (const entry of verifier.REVIEWED_HISTORY_BASELINE) {
    assert.ok(entry.commit, 'private history baseline entry must have a commit');
    assert.equal(verifierContent.includes(entry.commit), false, 'private history commit must not be embedded in public verifier source');
  }
  for (const sha of policy.REVIEWED_BINARY_SHAS) {
    assert.equal(policyContent.includes(sha), false, 'private evidence SHA must not be embedded in public policy source');
  }
});

test('parseArgs parses CLI arguments and flags correctly', async () => {
  const scriptPath = path.join(ROOT_DIR, 'scripts/verify-public-release.mjs');
  const { parseArgs } = await import(`file://${scriptPath}`);

  const defaultParsed = parseArgs([]);
  assert.equal(defaultParsed.skipPublicReady, false);
  assert.equal(defaultParsed.skipCleanExport, false);
  assert.equal(defaultParsed.json, false);
  assert.equal(defaultParsed.cwd, ROOT_DIR);

  const skipParsed = parseArgs(['--skip-public-ready', '--skip-clean-export', '--json']);
  assert.equal(skipParsed.skipPublicReady, true);
  assert.equal(skipParsed.skipCleanExport, true);
  assert.equal(skipParsed.json, true);

  const cwdParsed = parseArgs(['--cwd', '/tmp']);
  assert.equal(cwdParsed.cwd, path.resolve('/tmp'));
});

test('matchesBaseline strictly validates non-empty hex commit (>=7 chars) and never fails open', async () => {
  const scriptPath = path.join(ROOT_DIR, 'scripts/verify-public-release.mjs');
  const { matchesBaseline } = await import(`file://${scriptPath}`);

  const baseline = {
    category: 'local_home_path',
    path: 'apps/agent/src/background.test.ts',
    commit: 'abcdef1234567890abcdef1234567890abcdef12',
    reason: 'Mock path',
  };

  // 1. Missing commit
  assert.equal(
    matchesBaseline({ category: 'local_home_path', path: 'apps/agent/src/background.test.ts' }, baseline),
    false,
    'missing commit must not match',
  );
  assert.equal(
    matchesBaseline({ category: 'local_home_path', path: 'apps/agent/src/background.test.ts', commit: undefined }, baseline),
    false,
    'undefined commit must not match',
  );
  assert.equal(
    matchesBaseline({ category: 'local_home_path', path: 'apps/agent/src/background.test.ts', commit: null }, baseline),
    false,
    'null commit must not match',
  );

  // 2. Empty or whitespace commit
  assert.equal(
    matchesBaseline({ category: 'local_home_path', path: 'apps/agent/src/background.test.ts', commit: '' }, baseline),
    false,
    'empty commit must not match',
  );
  assert.equal(
    matchesBaseline({ category: 'local_home_path', path: 'apps/agent/src/background.test.ts', commit: '   ' }, baseline),
    false,
    'whitespace commit must not match',
  );

  // 3. Short commit (< 7 hex characters)
  assert.equal(
    matchesBaseline({ category: 'local_home_path', path: 'apps/agent/src/background.test.ts', commit: 'abcdef' }, baseline),
    false,
    '6-char commit must not match',
  );
  assert.equal(
    matchesBaseline({ category: 'local_home_path', path: 'apps/agent/src/background.test.ts', commit: '6' }, baseline),
    false,
    '1-char commit must not match',
  );

  // 4. Invalid non-hex commit
  assert.equal(
    matchesBaseline({ category: 'local_home_path', path: 'apps/agent/src/background.test.ts', commit: 'abcdefg' }, baseline),
    false,
    'non-hex commit must not match',
  );

  // 5. Mismatched commit
  assert.equal(
    matchesBaseline({ category: 'local_home_path', path: 'apps/agent/src/background.test.ts', commit: '1234567' }, baseline),
    false,
    'different 7-char commit must not match',
  );
  assert.equal(
    matchesBaseline(
      { category: 'local_home_path', path: 'apps/agent/src/background.test.ts', commit: '1234567890abcdef1234567890abcdef12345678' },
      baseline,
    ),
    false,
    'different full commit must not match',
  );

  // 6. Baseline with invalid/short commit must not match
  const invalidBaseline = {
    category: 'local_home_path',
    path: 'apps/agent/src/background.test.ts',
    commit: 'abcdef',
  };
  assert.equal(
    matchesBaseline({ category: 'local_home_path', path: 'apps/agent/src/background.test.ts', commit: 'abcdef' }, invalidBaseline),
    false,
    'baseline with short commit must not match',
  );

  // 7. Valid matching commit (exact and prefix, case-insensitive)
  assert.equal(
    matchesBaseline({ category: 'local_home_path', path: 'apps/agent/src/background.test.ts', commit: 'abcdef1' }, baseline),
    true,
    'valid 7-char prefix of baseline commit must match',
  );
  assert.equal(
    matchesBaseline(
      { category: 'local_home_path', path: 'apps/agent/src/background.test.ts', commit: 'abcdef1234567890abcdef1234567890abcdef12' },
      baseline,
    ),
    true,
    'exact 40-char SHA match must match',
  );
  assert.equal(
    matchesBaseline(
      { category: 'local_home_path', path: 'apps/agent/src/background.test.ts', commit: 'ABCDEF1234567890ABCDEF1234567890ABCDEF12' },
      baseline,
    ),
    true,
    'uppercase hex SHA match must match',
  );

  // 8. Category or path mismatch
  assert.equal(
    matchesBaseline({ category: 'secret', path: 'apps/agent/src/background.test.ts', commit: 'abcdef1' }, baseline),
    false,
    'mismatched category must not match',
  );
  assert.equal(
    matchesBaseline({ category: 'local_home_path', path: 'apps/agent/src/other.test.ts', commit: 'abcdef1' }, baseline),
    false,
    'mismatched path must not match',
  );
});

test('checkHistoryAgainstBaseline passes when findings are covered by reviewed baseline', async () => {
  const scriptPath = path.join(ROOT_DIR, 'scripts/verify-public-release.mjs');
  const { checkHistoryAgainstBaseline } = await import(`file://${scriptPath}`);

  const syntheticBaseline = [
    { category: 'local_home_path', path: 'fixtures/home.txt', commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', reason: 'synthetic test' },
    { category: 'email_address', path: 'fixtures/email.txt', commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', reason: 'synthetic test' },
    { category: 'private_firebase_marker', path: 'fixtures/firebase.txt', commit: 'cccccccccccccccccccccccccccccccccccccccc', reason: 'synthetic test' },
  ];
  const syntheticReviewed = syntheticBaseline.map((entry) => ({
    severity: 'BLOCKER',
    category: entry.category,
    path: entry.path,
    commit: entry.commit,
    detail: 'synthetic policy finding',
  }));

  const result = checkHistoryAgainstBaseline(syntheticReviewed, syntheticBaseline);
  assert.equal(result.isClean, true);
  assert.equal(result.unreviewedCount, 0);
  assert.equal(result.reviewedCount, 3);
  assert.deepEqual(result.unreviewed, []);
});

test('checkHistoryAgainstBaseline fails closed on new/unreviewed historical findings', async () => {
  const scriptPath = path.join(ROOT_DIR, 'scripts/verify-public-release.mjs');
  const { checkHistoryAgainstBaseline, REVIEWED_HISTORY_BASELINE } = await import(`file://${scriptPath}`);

  const unreviewedCandidate = [
    {
      severity: 'BLOCKER',
      category: 'secret',
      path: 'packages/core/src/leaked-key.ts',
      commit: '1234567890abcdef1234567890abcdef12345678',
      detail: 'detected Google API key: AIzaSyDUMMYKEY1234567890',
    },
  ];

  const result = checkHistoryAgainstBaseline(unreviewedCandidate, REVIEWED_HISTORY_BASELINE);
  assert.equal(result.isClean, false);
  assert.equal(result.unreviewedCount, 1);
  assert.equal(result.reviewedCount, 0);
  assert.equal(result.unreviewed[0].path, 'packages/core/src/leaked-key.ts');
});

test('formatBoundedFinding formats count/category/path/commit only and never echoes matched values or secrets', async () => {
  const scriptPath = path.join(ROOT_DIR, 'scripts/verify-public-release.mjs');
  const { formatBoundedFinding } = await import(`file://${scriptPath}`);

  const rawFinding = {
    severity: 'BLOCKER',
    category: 'secret',
    path: 'src/config.ts',
    commit: 'abcdef1234567890abcdef1234567890abcdef12',
    detail: 'detected Firebase API key: AIzaSySECRETVALUE999999',
    matchedValue: 'AIzaSySECRETVALUE999999',
    env: { AWS_SECRET_ACCESS_KEY: 'LEAKED_ENV_VAR' },
  };

  const formatted = formatBoundedFinding(rawFinding);
  assert.ok(formatted.includes('BLOCKER'));
  assert.ok(formatted.includes('secret'));
  assert.ok(formatted.includes('src/config.ts'));
  assert.ok(formatted.includes('abcdef1'));
  assert.ok(!formatted.includes('AIzaSySECRETVALUE999999'), 'must not contain secret value');
  assert.ok(!formatted.includes('LEAKED_ENV_VAR'), 'must not contain environment variable');
});

test('verifyPublicRelease orchestrator enforces fail-fast error handling for each gate component', async () => {
  const scriptPath = path.join(ROOT_DIR, 'scripts/verify-public-release.mjs');
  const { verifyPublicRelease } = await import(`file://${scriptPath}`);

  // Test 1: Tree blocker fails fast
  const treeFailResult = await verifyPublicRelease({
    cwd: ROOT_DIR,
    skipPublicReady: true,
    skipCleanExport: true,
    skipHistory: true,
    skipExport: true,
    skipDocs: true,
    skipLicense: true,
    skipAudit: true,
    mockTreeFindings: [
      {
        severity: 'BLOCKER',
        category: 'credential_filename',
        path: '.env.production',
        detail: 'credential filename pattern',
      },
    ],
  });
  assert.equal(treeFailResult.success, false);
  assert.equal(treeFailResult.failedStep, 'audit:tree');

  // Test 2: Unreviewed history blocker fails fast
  const historyFailResult = await verifyPublicRelease({
    cwd: ROOT_DIR,
    skipPublicReady: true,
    skipCleanExport: true,
    skipTree: true,
    skipExport: true,
    skipDocs: true,
    skipLicense: true,
    skipAudit: true,
    mockHistoryFindings: [
      {
        severity: 'BLOCKER',
        category: 'secret',
        path: 'unknown-path.js',
        commit: '9999999999999999999999999999999999999999',
        detail: 'detected token',
      },
    ],
  });
  assert.equal(historyFailResult.success, false);
  assert.equal(historyFailResult.failedStep, 'audit:history');

  // Test 3: Clean components pass
  const cleanResult = await verifyPublicRelease({
    cwd: ROOT_DIR,
    skipPublicReady: true,
    skipCleanExport: true,
    mockTreeFindings: [],
    mockHistoryFindings: [],
    mockExportResult: !isGitWorktree(ROOT_DIR) ? { success: true, exportedFilesCount: 50 } : undefined,
  });
  assert.equal(cleanResult.success, true);
  assert.equal(cleanResult.failedStep, null);

  // Test 4: Clean export failure fails fast
  const exportFailResult = await verifyPublicRelease({
    cwd: ROOT_DIR,
    skipPublicReady: true,
    mockTreeFindings: [],
    mockHistoryFindings: [],
    mockExportResult: { success: true, exportedFilesCount: 50 },
    mockCleanExportResult: { success: false, error: 'Simulated clean export failure' },
  });
  assert.equal(exportFailResult.success, false);
  assert.equal(exportFailResult.failedStep, 'test:clean-export');
});

test('checkHistoryAgainstBaseline fails closed on findings with missing, empty, short, or mismatched commit', async () => {
  const scriptPath = path.join(ROOT_DIR, 'scripts/verify-public-release.mjs');
  const { checkHistoryAgainstBaseline, REVIEWED_HISTORY_BASELINE } = await import(`file://${scriptPath}`);

  const badFindings = [
    {
      severity: 'BLOCKER',
      category: 'local_home_path',
      path: 'apps/agent/src/background.test.ts',
      // missing commit
    },
    {
      severity: 'BLOCKER',
      category: 'local_home_path',
      path: 'apps/agent/src/background.test.ts',
      commit: '',
    },
    {
      severity: 'BLOCKER',
      category: 'local_home_path',
      path: 'apps/agent/src/background.test.ts',
      commit: 'abcdef', // 6 hex characters
    },
    {
      severity: 'BLOCKER',
      category: 'local_home_path',
      path: 'apps/agent/src/background.test.ts',
      commit: '1234567', // valid 7 hex characters, but wrong commit
    },
  ];

  const result = checkHistoryAgainstBaseline(badFindings, REVIEWED_HISTORY_BASELINE);
  assert.equal(result.isClean, false);
  assert.equal(result.reviewedCount, 0);
  assert.equal(result.unreviewedCount, 4);
  assert.equal(result.unreviewed.length, 4);
});

test('verifyPublicRelease prevents double execution of verify:public-ready when skipPublicReady is enabled', async () => {
  const scriptPath = path.join(ROOT_DIR, 'scripts/verify-public-release.mjs');
  const { verifyPublicRelease } = await import(`file://${scriptPath}`);

  // When skipPublicReady is false and public-ready fails, verifyPublicRelease must fail at verify:public-ready
  const failResult = await verifyPublicRelease({
    cwd: ROOT_DIR,
    skipTree: true,
    skipHistory: true,
    skipExport: true,
    skipCleanExport: true,
    skipDocs: true,
    skipLicense: true,
    skipAudit: true,
    skipPublicReady: false,
    mockPublicReadyResult: { status: 1 },
  });
  assert.equal(failResult.success, false);
  assert.equal(failResult.failedStep, 'verify:public-ready');

  // When skipPublicReady is true, verifyPublicRelease must not run verify:public-ready and succeed
  const skipResult = await verifyPublicRelease({
    cwd: ROOT_DIR,
    skipTree: true,
    skipHistory: true,
    skipExport: true,
    skipCleanExport: true,
    skipDocs: true,
    skipLicense: true,
    skipAudit: true,
    skipPublicReady: true,
    mockPublicReadyResult: { status: 1 },
  });
  assert.equal(skipResult.success, true);
  assert.equal(skipResult.failedStep, null);
  assert.equal(skipResult.publicReadySkipped, true);
});


test('verifyPublicRelease fails closed when a required documentation test file is missing', async () => {
  const { verifyPublicRelease } = await import('../scripts/verify-public-release.mjs');
  const result = await verifyPublicRelease({
    cwd: ROOT_DIR,
    skipTree: true, skipHistory: true, skipExport: true, skipCleanExport: true,
    skipLicense: true, skipAudit: true, skipPublicReady: true,
    docsTestFiles: ['tests/definitely-missing-release-doc-test.mjs'],
    verbose: false,
  });
  assert.equal(result.success, false);
  assert.equal(result.failedStep, 'test:docs');
  assert.match(result.error, /missing|required/i);
});


test('reviewed history baseline covers the current audited Git history exactly', async (t) => {
  if (!isGitWorktree(ROOT_DIR)) {
    t.skip('requires Git history');
    return;
  }
  const [{ auditGitHistory }, verifier] = await Promise.all([
    import('../scripts/audit-public-release.mjs'),
    import('../scripts/verify-public-release.mjs'),
  ]);
  const findings = auditGitHistory(ROOT_DIR).filter((f) => f.severity === 'BLOCKER');
  const result = verifier.checkHistoryAgainstBaseline(findings, verifier.REVIEWED_HISTORY_BASELINE);
  const bounded = result.unreviewed.map(verifier.formatBoundedFinding).join('; ');
  assert.equal(result.unreviewedCount, 0, `unreviewed history findings: ${bounded}`);
});
