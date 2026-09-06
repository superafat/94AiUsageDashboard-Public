import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { exportPublicRelease } from '../scripts/export-public-release.mjs';

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

/**
 * Copies all exported bytes from the sanitized export directory into a fresh temporary directory.
 * Asserts that forbidden private items (.git, .env, .superpowers, caches) are not present.
 */
export function copyExportedBytes(exportDir, targetDir) {
  if (!exportDir || !fs.existsSync(exportDir)) {
    throw new Error(`Export directory does not exist: ${exportDir}`);
  }
  if (!targetDir) {
    throw new Error('targetDir must be specified');
  }
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.cpSync(exportDir, targetDir, { recursive: true });

  const forbidden = [
    '.git',
    '.env.local',
    '.env',
    '.superpowers',
    'docs/superpowers',
    'docs/evidence',
    'node_modules',
  ];

  for (const item of forbidden) {
    const fullPath = path.join(targetDir, item);
    if (fs.existsSync(fullPath)) {
      throw new Error(`Forbidden item present in clean directory: ${item}`);
    }
  }

  const required = [
    'package.json',
    'package-lock.json',
    'PUBLIC_EXPORT_MANIFEST.sha256',
    '.env.example',
    'LICENSE',
  ];
  for (const item of required) {
    const fullPath = path.join(targetDir, item);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Required exported file missing in clean directory: ${item}`);
    }
  }

  return { success: true };
}

/**
 * Validates doctor --json output:
 * - Must be valid JSON matching schemaVersion: 1
 * - Must report bounded missing-prerequisite status (backendConfig -> needs-action, backend_missing, configure_firebase)
 * - Must NEVER leak absolute local user paths, tokens, or error stack traces.
 */
export function verifyDoctorDiagnostics(doctorOutput) {
  if (typeof doctorOutput !== 'string') {
    throw new Error('doctorOutput must be a string');
  }

  const jsonStart = doctorOutput.indexOf('{');
  const jsonEnd = doctorOutput.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error('No valid JSON object found in doctor output');
  }

  const jsonStr = doctorOutput.slice(jsonStart, jsonEnd + 1);
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Failed to parse doctor JSON output: ${err.message}`);
  }

  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unexpected schemaVersion: ${parsed.schemaVersion}`);
  }

  if (!parsed.checks || typeof parsed.checks !== 'object') {
    throw new Error('doctor output missing checks object');
  }

  const backendConfig = parsed.checks.backendConfig;
  if (!backendConfig) {
    throw new Error('doctor output missing backendConfig check');
  }

  if (backendConfig.state !== 'needs-action') {
    throw new Error(`backendConfig.state expected 'needs-action' but got '${backendConfig.state}'`);
  }
  if (backendConfig.code !== 'backend_missing') {
    throw new Error(`backendConfig.code expected 'backend_missing' but got '${backendConfig.code}'`);
  }
  if (backendConfig.nextAction !== 'configure_firebase') {
    throw new Error(`backendConfig.nextAction expected 'configure_firebase' but got '${backendConfig.nextAction}'`);
  }

  // Assert NO filesystem home/user paths
  if (/\/(?:Users|home|private\/var)\/[a-zA-Z0-9_-]+/i.test(jsonStr)) {
    throw new Error('Doctor output leaked filesystem user path');
  }

  // Assert NO sensitive API keys or OAuth refresh tokens
  if (/AIza[0-9A-Za-z_-]{20,}/.test(jsonStr) || /ya29\.[0-9A-Za-z_-]+/.test(jsonStr)) {
    throw new Error('Doctor output leaked API key or OAuth token');
  }

  // Assert NO stack traces
  if (/(?:^\s*at\s+[a-zA-Z0-9_./<>]+:\d+:\d+|Error:\s+)/m.test(jsonStr)) {
    throw new Error('Doctor output leaked error stack trace');
  }

  return {
    valid: true,
    overall: parsed.overall,
    backendConfigCode: backendConfig.code,
    backendConfigNextAction: backendConfig.nextAction,
    checks: parsed.checks,
  };
}

/**
 * Inspects built production Web output and proves fixture/test mode cannot activate:
 * - Assets must exist in dist/assets
 * - createE2EServices must NOT be in the production bundle (tree-shaken out)
 * - fixture query string parsing from location.search must NOT be present
 * - VITE_E2E must NOT be present
 */
export function verifyWebBundleFixtureProtection(distAssetsDir) {
  if (!fs.existsSync(distAssetsDir)) {
    throw new Error(`Dist assets directory does not exist: ${distAssetsDir}`);
  }

  const entries = fs.readdirSync(distAssetsDir);
  const jsFiles = entries.filter((f) => f.endsWith('.js'));
  if (jsFiles.length === 0) {
    throw new Error(`No JavaScript bundles found in ${distAssetsDir}`);
  }

  const inspected = [];
  for (const jsFile of jsFiles) {
    const fullPath = path.join(distAssetsDir, jsFile);
    const content = fs.readFileSync(fullPath, 'utf8');
    inspected.push(jsFile);

    if (content.includes('createE2EServices')) {
      throw new Error(`Production bundle ${jsFile} contains createE2EServices`);
    }

    if (content.includes('.get("fixture")') || content.includes(".get('fixture')")) {
      throw new Error(`Production bundle ${jsFile} queries fixture URL parameter`);
    }

    if (content.includes('VITE_E2E')) {
      throw new Error(`Production bundle ${jsFile} contains VITE_E2E`);
    }
  }

  return {
    valid: true,
    fixtureModeEliminated: true,
    inspectedFiles: inspected,
  };
}

export function assertRequiredFiles(baseDir, files, label = 'required file') {
  for (const relPath of files) {
    if (!fs.existsSync(path.join(baseDir, relPath))) {
      throw new Error(`${label} missing: ${relPath}`);
    }
  }
  return files;
}

export function cleanupAcceptanceDirectories({ exportDir, cleanDir, keepExportDir = false, keepCleanDir = false }) {
  if (!keepCleanDir && cleanDir && fs.existsSync(cleanDir)) {
    try { fs.rmSync(cleanDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (!keepExportDir && exportDir && fs.existsSync(exportDir)) {
    try { fs.rmSync(exportDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Runs the end-to-end clean export acceptance test:
 * 1. Creates a fresh temporary directory from the exported tree only.
 * 2. Runs npm ci, npm run typecheck, npm test, npm run build, npm run scan:secrets, and docs tests.
 * 3. Runs npm run usage -- doctor --json with no private config and asserts bounded diagnostics.
 * 4. Inspects generated production Web output and proves VITE_E2E=0 fixture protection remains active.
 * 5. Records exact source SHA, manifest SHA256, Node version, and actual pass/fail counts.
 */
export async function runCleanExportAcceptance(options = {}) {
  const repoCwd = path.resolve(options.cwd ?? process.cwd());
  const exportDir = path.resolve(options.exportDir ?? path.join(os.tmpdir(), `94aiusage-v0.1.2-public-${Date.now()}`));
  const cleanDir = path.resolve(options.cleanDir ?? fs.mkdtempSync(path.join(os.tmpdir(), '94aiusage-clean-acceptance-')));
  const verbose = options.verbose ?? false;
  const keepCleanDir = options.keepCleanDir ?? false;
  const keepExportDir = options.keepExportDir ?? false;

  const log = (msg) => {
    if (verbose) console.log(msg);
  };

  const steps = {};

  try {
    // Step 1: Create/refresh export via supported exporter
    log('[1/8] Creating/refreshing public export...');
    const exportResult = options.mockExportResult ?? exportPublicRelease({
      cwd: repoCwd,
      outDir: exportDir,
    });
    if (!exportResult || !exportResult.success) {
      throw new Error('Public export failed');
    }
    steps.export = { success: true, exportedFilesCount: exportResult.exportedFilesCount };

    // Copy only exported bytes into fresh temp dir
    log('[2/8] Copying exported bytes into clean room...');
    copyExportedBytes(exportDir, cleanDir);
    steps.copyCleanBytes = { success: true };

    // Record source commit and manifest SHA-256
    const manifestPath = path.join(cleanDir, 'PUBLIC_EXPORT_MANIFEST.sha256');
    const manifestContent = fs.readFileSync(manifestPath, 'utf8');
    const manifestSha256 = crypto.createHash('sha256').update(manifestContent).digest('hex');
    const sourceCommitMatch = manifestContent.match(/^# source_commit: ([0-9a-f]{40})/i);
    const sourceCommit = sourceCommitMatch ? sourceCommitMatch[1] : (options.commitSha ?? 'unknown');

    // Sanitized clean-room child environment (zero secrets, zero private config, zero test worker contexts)
    const cleanEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SHELL: process.env.SHELL,
      USER: process.env.USER,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      TERM: 'dumb',
      NODE_ENV: 'test',
      VITE_E2E: '0',
    };

    const runInCleanDir = (cmd, args, stepName) => {
      log(`Running ${cmd} ${args.join(' ')}...`);
      const start = Date.now();
      const res = spawnSync(cmd, args, {
        cwd: cleanDir,
        env: cleanEnv,
        encoding: 'utf8',
        stdio: verbose ? 'inherit' : 'pipe',
      });
      const durationMs = Date.now() - start;
      if (res.status !== 0) {
        const stderr = (res.stderr || '').trim();
        const stdout = (res.stdout || '').trim();
        const combined = [stderr, stdout].filter(Boolean).join('\n');
        const lastLines = combined.split('\n').slice(-30).join('\n');
        throw new Error(`${stepName} failed (${res.status}):\n${lastLines || `exited with status ${res.status}`}`);
      }
      return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', durationMs };
    }

    // Step 2a: npm ci
    log('[3/8] Running npm ci...');
    const npmCiRes = runInCleanDir('npm', ['ci'], 'npm ci');
    steps.npmCi = { success: true, durationMs: npmCiRes.durationMs };

    // Step 2b: npm run typecheck
    log('[4/8] Running npm run typecheck...');
    const typecheckRes = runInCleanDir('npm', ['run', 'typecheck'], 'npm run typecheck');
    steps.typecheck = { success: true, durationMs: typecheckRes.durationMs };

    // Step 2c: npm test
    log('[5/8] Running npm test...');
    const testRes = runInCleanDir('npm', ['test'], 'npm test');
    steps.npmTest = { success: true, durationMs: testRes.durationMs };

    // Step 2d: npm run build
    log('[6/8] Running npm run build...');
    const buildRes = runInCleanDir('npm', ['run', 'build'], 'npm run build');
    steps.npmBuild = { success: true, durationMs: buildRes.durationMs };

    // Step 2e: npm run scan:secrets
    log('[7/8] Running npm run scan:secrets...');
    const scanRes = runInCleanDir('npm', ['run', 'scan:secrets'], 'npm run scan:secrets');
    steps.scanSecrets = { success: true, durationMs: scanRes.durationMs };

    // Step 2f: documentation tests
    log('[8/8] Running documentation tests...');
    const docsFiles = [
      'tests/docs.test.mjs',
      'tests/ai-install-doc.test.mjs',
      'tests/getting-started-doc.test.mjs',
      'tests/install-docs.test.mjs',
      'tests/privacy-docs.test.mjs',
      'tests/public-lifecycle-docs.test.mjs',
      'tests/setup-docs.test.mjs',
      'tests/history-privacy.test.mjs',
    ];
    assertRequiredFiles(cleanDir, docsFiles, 'Required documentation test file');
    const docsRes = runInCleanDir(process.execPath, ['--test', ...docsFiles], 'docs tests');
    steps.docsTests = { success: true, durationMs: docsRes.durationMs };

    // Step 3: npm run usage -- doctor --json
    log('[Step 3] Running npm run usage -- doctor --json...');
    const doctorRes = runInCleanDir('npm', ['run', 'usage', '--', 'doctor', '--json'], 'usage doctor --json');
    const doctorVerification = verifyDoctorDiagnostics(doctorRes.stdout);
    steps.doctorJson = { success: true, ...doctorVerification };

    // Step 4: Inspect production Web bundle
    log('[Step 4] Inspecting production Web output...');
    const distAssetsDir = path.join(cleanDir, 'apps/web/dist/assets');
    const webVerification = verifyWebBundleFixtureProtection(distAssetsDir);
    steps.webBundleProtection = { success: true, ...webVerification };

    return {
      success: true,
      sourceCommit,
      manifestSha256,
      nodeVersion: process.version,
      npmVersion: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
      cleanDir,
      steps,
      failedStep: null,
      error: null,
    };
  } catch (err) {
    return {
      success: false,
      cleanDir,
      steps,
      failedStep: Object.keys(steps).pop() || 'initialization',
      error: err.message,
    };
  } finally {
    cleanupAcceptanceDirectories({ exportDir, cleanDir, keepExportDir, keepCleanDir });
  }
}

const isDirectTestExecution = process.argv.some((arg) => arg.includes('clean-public-export-acceptance.mjs'));

if (isDirectTestExecution) {
  // Unit tests for clean export acceptance helpers
  test('copyExportedBytes copies exported files and enforces exclusions', () => {
  const tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-test-src-'));
  const tmpDest = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-test-dest-'));
  try {
    fs.writeFileSync(path.join(tmpSrc, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmpSrc, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(tmpSrc, 'PUBLIC_EXPORT_MANIFEST.sha256'), '# manifest');
    fs.writeFileSync(path.join(tmpSrc, '.env.example'), 'VAR=1');

    const result = copyExportedBytes(tmpSrc, tmpDest);
    assert.equal(result.success, true);
    assert.ok(fs.existsSync(path.join(tmpDest, 'package.json')));
    assert.ok(fs.existsSync(path.join(tmpDest, 'PUBLIC_EXPORT_MANIFEST.sha256')));

    // If source had .git, copyExportedBytes must fail closed
    fs.mkdirSync(path.join(tmpSrc, '.git'));
    const tmpDest2 = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-test-dest2-'));
    try {
      assert.throws(
        () => copyExportedBytes(tmpSrc, tmpDest2),
        /Forbidden item present in clean directory: \.git/,
      );
    } finally {
      fs.rmSync(tmpDest2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmpSrc, { recursive: true, force: true });
    fs.rmSync(tmpDest, { recursive: true, force: true });
  }
});

test('verifyDoctorDiagnostics asserts schemaVersion, missing-prerequisite status and zero leakage', () => {
  const validOutput = `
../../.env.local not found. Continuing without it.
{
  "schemaVersion": 1,
  "overall": "needs-action",
  "checks": {
    "platform": { "state": "ready", "code": "platform_ready", "label": "macOS 可用", "nextAction": "none" },
    "engine": { "state": "ready", "code": "engine_ready", "label": "額度引擎可用", "nextAction": "none" },
    "backendConfig": { "state": "needs-action", "code": "backend_missing", "label": "尚未完成同步服務設定", "nextAction": "configure_firebase" },
    "auth": { "state": "ready", "code": "auth_ready", "label": "帳號登入完成", "nextAction": "none" },
    "background": { "state": "ready", "code": "background_ready", "label": "背景同步已安裝", "nextAction": "none" },
    "sync": { "state": "ready", "code": "sync_ready", "label": "最近同步正常（4 個來源）", "nextAction": "none" }
  }
}
`;
  const verified = verifyDoctorDiagnostics(validOutput);
  assert.equal(verified.valid, true);
  assert.equal(verified.backendConfigCode, 'backend_missing');
  assert.equal(verified.backendConfigNextAction, 'configure_firebase');
});

test('verifyDoctorDiagnostics rejects leaking paths, tokens, and stack traces', () => {
  const fakeHome = ['/', 'Users', 'syntheticuser', 'secret'].join('/');
  const leakingPath = `{"schemaVersion": 1, "overall": "needs-action", "checks": {"backendConfig": {"state": "needs-action", "code": "backend_missing", "nextAction": "configure_firebase", "label": "${fakeHome}" }}}`;
  assert.throws(() => verifyDoctorDiagnostics(leakingPath), /leaked filesystem user path/);

  const fakeKey = ['AIza', 'SyDdummytokenvalue1234567890123456'].join('');
  const leakingToken = `{"schemaVersion": 1, "overall": "needs-action", "checks": {"backendConfig": {"state": "needs-action", "code": "backend_missing", "nextAction": "configure_firebase", "label": "${fakeKey}" }}}`;
  assert.throws(() => verifyDoctorDiagnostics(leakingToken), /leaked API key or OAuth token/);

  const leakingStack = `{"schemaVersion": 1, "overall": "needs-action", "checks": {"backendConfig": {"state": "needs-action", "code": "backend_missing", "nextAction": "configure_firebase", "label": "Error: boom" }}}\n  at runDoctor (/file.js:10:5)`;
  assert.throws(() => verifyDoctorDiagnostics(leakingStack), /leaked error stack trace/);
});

test('verifyWebBundleFixtureProtection asserts fixture mode cannot activate in production bundle', () => {
  const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'web-bundle-test-'));
  try {
    // Valid production bundle with dead code eliminated
    fs.writeFileSync(path.join(tmpDist, 'index-valid.js'), 'console.log("clean bundle");');
    const result = verifyWebBundleFixtureProtection(tmpDist);
    assert.equal(result.valid, true);
    assert.equal(result.fixtureModeEliminated, true);

    // Bundle leaking createE2EServices
    fs.writeFileSync(path.join(tmpDist, 'index-bad1.js'), 'function createE2EServices() {}');
    assert.throws(() => verifyWebBundleFixtureProtection(tmpDist), /contains createE2EServices/);

    // Bundle leaking fixture search parameter query
    fs.unlinkSync(path.join(tmpDist, 'index-bad1.js'));
    fs.writeFileSync(path.join(tmpDist, 'index-bad2.js'), 'new URLSearchParams().get("fixture")');
    assert.throws(() => verifyWebBundleFixtureProtection(tmpDist), /queries fixture URL parameter/);
  } finally {
    fs.rmSync(tmpDist, { recursive: true, force: true });
  }
});

test('runCleanExportAcceptance runs full clean-room acceptance across clean export', async (t) => {
  if (!isGitWorktree(process.cwd())) {
    t.skip('Skipping full live workspace clean export acceptance when running in a non-Git exported release directory');
    return;
  }

  const result = await runCleanExportAcceptance({
    cwd: process.cwd(),
    verbose: false,
  });

  assert.equal(result.success, true, `Clean export acceptance failed: ${result.error}`);
  assert.match(result.sourceCommit, /^[0-9a-f]{40}$/i, 'must record 40-char source commit');
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/i, 'must record 64-char manifest SHA-256');
  assert.ok(result.nodeVersion.startsWith('v'), 'must record Node version');
  assert.ok(result.steps.npmCi.success, 'npm ci must succeed');
  assert.ok(result.steps.typecheck.success, 'typecheck must succeed');
  assert.ok(result.steps.npmTest.success, 'npm test must succeed');
  assert.ok(result.steps.npmBuild.success, 'npm run build must succeed');
  assert.ok(result.steps.scanSecrets.success, 'npm run scan:secrets must succeed');
  assert.ok(result.steps.docsTests.success, 'docs tests must succeed');
  assert.ok(result.steps.doctorJson.success, 'doctor --json must succeed');
  assert.ok(result.steps.webBundleProtection.success, 'web bundle inspection must succeed');
});

test('clean acceptance cleanup removes both temporary directories', () => {
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-export-'));
  const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-clean-'));
  cleanupAcceptanceDirectories({ exportDir, cleanDir });
  assert.equal(fs.existsSync(exportDir), false);
  assert.equal(fs.existsSync(cleanDir), false);
});

test('clean acceptance required-file assertion fails closed', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'required-docs-'));
  try {
    assert.throws(() => assertRequiredFiles(tmpDir, ['tests/missing-doc.test.mjs'], 'documentation test'), /missing/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

}
