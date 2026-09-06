import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditPublicTree, auditGitHistory } from './audit-public-release.mjs';
import { exportPublicRelease } from './export-public-release.mjs';
import { loadPrivateReleaseBaseline } from './public-release-policy.mjs';
import { runCleanExportAcceptance } from '../tests/clean-public-export-acceptance.mjs';

/**
 * Authoritative reviewed Git-history baseline.
 * Contains reviewed synthetic test fixtures, policy strings, doc references,
 * and allowlisted screenshot binaries recorded in docs/evidence/v0.1.2-public-audit-inventory.md.
 *
 * Rules:
 * - Category, path, commit, reason ONLY.
 * - Never contains secret values, passwords, personal tokens, or live environment secrets.
 * - Any finding in Git history not matching this baseline fails verify:public-release.
 */
export const REVIEWED_HISTORY_BASELINE = loadPrivateReleaseBaseline().history;

const HEX_COMMIT_REGEX = /^[0-9a-fA-F]{7,}$/;

/**
 * Checks if a finding is covered by an entry in the reviewed baseline.
 * Matches category, path, and commit (requiring non-empty valid SHA/prefix >= 7 hex chars on both sides).
 */
export function matchesBaseline(finding, baselineEntry) {
  if (!finding || !baselineEntry) return false;
  if (finding.category !== baselineEntry.category) return false;
  if (finding.path !== baselineEntry.path) return false;
  if (baselineEntry.commit) {
    if (!finding.commit || typeof finding.commit !== 'string') {
      return false;
    }
    const fCommit = finding.commit.trim();
    const bCommit = typeof baselineEntry.commit === 'string' ? baselineEntry.commit.trim() : '';
    if (!HEX_COMMIT_REGEX.test(fCommit) || !HEX_COMMIT_REGEX.test(bCommit)) {
      return false;
    }
    const fLower = fCommit.toLowerCase();
    const bLower = bCommit.toLowerCase();
    if (!fLower.startsWith(bLower) && !bLower.startsWith(fLower)) {
      return false;
    }
  }
  return true;
}

/**
 * Bounded finding formatter:
 * Strictly outputs category, path, and commit prefix.
 * NEVER echoes matched secret values, environment variables, or canary tokens.
 */
export function formatBoundedFinding(finding) {
  const commitStr = finding.commit ? ` (commit: ${finding.commit.slice(0, 7)})` : '';
  const severityStr = finding.severity ? `[${finding.severity}] ` : '';
  return `${severityStr}[${finding.category}] ${finding.path}${commitStr}`;
}

/**
 * Checks Git history findings against the reviewed baseline.
 * If any finding is not covered, it is categorized as unreviewed and must fail.
 */
export function checkHistoryAgainstBaseline(findings, baseline = REVIEWED_HISTORY_BASELINE) {
  const unreviewed = [];
  const reviewed = [];

  for (const f of findings) {
    const matched = baseline.find((b) => matchesBaseline(f, b));
    if (matched) {
      reviewed.push({ finding: f, baseline: matched });
    } else {
      unreviewed.push(f);
    }
  }

  return {
    isClean: unreviewed.length === 0,
    reviewedCount: reviewed.length,
    unreviewedCount: unreviewed.length,
    unreviewed,
    reviewed,
  };
}

/**
 * Canonical orchestrator for v0.1.2 public release gate.
 * Executes all required release gates with fail-fast exit codes and bounded summaries.
 */
export async function verifyPublicRelease(options = {}) {
  const repoCwd = path.resolve(options.cwd ?? process.cwd());
  const verbose = options.verbose ?? true;
  const log = (msg) => {
    if (verbose && !options.json) console.log(msg);
  };
  const logErr = (msg) => {
    if (!options.json) console.error(msg);
  };

  // Step 1: Current-tree leakage audit (zero tolerance for blockers)
  if (!options.skipTree) {
    log('RUN audit:tree');
    const treeFindings = options.mockTreeFindings ?? auditPublicTree(repoCwd, options);
    const treeBlockers = treeFindings.filter((f) => f.severity === 'BLOCKER');
    if (treeBlockers.length > 0) {
      logErr(`FAIL audit:tree (${treeBlockers.length} blockers detected):`);
      for (const b of treeBlockers) {
        logErr(`  - ${formatBoundedFinding(b)}`);
      }
      return {
        success: false,
        failedStep: 'audit:tree',
        error: 'Tree blockers found',
        treeBlockersCount: treeBlockers.length,
      };
    }
    log('PASS audit:tree (0 blockers)');
  }

  // Step 2: Git-history audit against reviewed baseline
  if (!options.skipHistory) {
    log('RUN audit:history');
    const historyFindings = options.mockHistoryFindings ?? auditGitHistory(repoCwd, options);
    const historyBlockers = historyFindings.filter((f) => f.severity === 'BLOCKER');
    const baseline = options.baseline ?? REVIEWED_HISTORY_BASELINE;
    const historyCheck = checkHistoryAgainstBaseline(historyBlockers, baseline);

    if (!historyCheck.isClean) {
      logErr(`FAIL audit:history (${historyCheck.unreviewedCount} unreviewed historical findings):`);
      for (const u of historyCheck.unreviewed) {
        logErr(`  - [NEW_UNREVIEWED] ${formatBoundedFinding(u)}`);
      }
      return {
        success: false,
        failedStep: 'audit:history',
        error: 'Unreviewed history findings detected',
        unreviewedCount: historyCheck.unreviewedCount,
        unreviewed: historyCheck.unreviewed.map(formatBoundedFinding),
      };
    }
    log(`PASS audit:history (${historyCheck.reviewedCount} reviewed findings, 0 unreviewed)`);
  }

  // Step 3: Clean public export and export audit
  if (!options.skipExport) {
    log('RUN export:public');
    const tempExportDir = options.exportOutDir ?? path.join(os.tmpdir(), `94aiusage-public-export-${Date.now()}`);
    try {
      const exportResult = options.mockExportResult ?? exportPublicRelease({ cwd: repoCwd, outDir: tempExportDir });
      if (!exportResult || !exportResult.success) {
        throw new Error('Public export failed');
      }
      log(`PASS export:public (${exportResult.exportedFilesCount} files exported, manifest verified, 0 blockers)`);
    } catch (err) {
      logErr(`FAIL export:public: ${err.message}`);
      return {
        success: false,
        failedStep: 'export:public',
        error: err.message,
      };
    } finally {
      if (!options.keepExportDir && fs.existsSync(tempExportDir)) {
        try {
          fs.rmSync(tempExportDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  // Step 4: Clean public export acceptance (clean-room install, typecheck, test, build, scan, doctor, bundle)
  if (!options.skipCleanExport) {
    log('RUN test:clean-export');
    try {
      const cleanAcceptance = options.mockCleanExportResult ?? await runCleanExportAcceptance({
        cwd: repoCwd,
        verbose: false,
      });
      if (!cleanAcceptance || !cleanAcceptance.success) {
        throw new Error(cleanAcceptance?.error || 'Clean export acceptance failed');
      }
      log(`PASS test:clean-export (clean install, typecheck, test, build, scan, doctor, bundle verified in ${cleanAcceptance.cleanDir})`);
    } catch (err) {
      logErr(`FAIL test:clean-export: ${err.message}`);
      return {
        success: false,
        failedStep: 'test:clean-export',
        error: err.message,
      };
    }
  }

  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;

  // Step 4: Documentation tests
  if (!options.skipDocs) {
    log('RUN test:docs');
    const docsTestFiles = options.docsTestFiles ?? [
      'tests/docs.test.mjs',
      'tests/ai-install-doc.test.mjs',
      'tests/getting-started-doc.test.mjs',
      'tests/install-docs.test.mjs',
      'tests/privacy-docs.test.mjs',
      'tests/public-lifecycle-docs.test.mjs',
      'tests/setup-docs.test.mjs',
      'tests/history-privacy.test.mjs',
    ];
    const missingDocsTest = docsTestFiles.find((f) => !fs.existsSync(path.join(repoCwd, f)));
    if (missingDocsTest) {
      const error = `Required documentation test file missing: ${missingDocsTest}`;
      logErr(`FAIL test:docs (${error})`);
      return { success: false, failedStep: 'test:docs', error };
    }

    const docsRes = spawnSync(process.execPath, ['--test', ...docsTestFiles], {
      cwd: repoCwd,
      stdio: verbose ? 'inherit' : 'pipe',
      env: childEnv,
    });
    if (docsRes.status !== 0) {
      logErr('FAIL test:docs (documentation tests failed)');
      return {
        success: false,
        failedStep: 'test:docs',
        error: 'Docs tests failed',
        status: docsRes.status,
      };
    }
    log('PASS test:docs');
  }

  // Step 5: Dependency and license review test
  if (!options.skipLicense) {
    log('RUN test:license');
    const licenseRes = spawnSync(process.execPath, ['--test', 'tests/dependency-license.test.mjs'], {
      cwd: repoCwd,
      stdio: verbose ? 'inherit' : 'pipe',
      env: childEnv,
    });
    if (licenseRes.status !== 0) {
      logErr('FAIL test:license (dependency license review failed)');
      return {
        success: false,
        failedStep: 'test:license',
        error: 'License test failed',
        status: licenseRes.status,
      };
    }
    log('PASS test:license');
  }

  // Step 6: Direct dependency security audit
  if (!options.skipAudit) {
    log('RUN npm audit --omit=dev --audit-level=high');
    const auditRes = spawnSync('npm', ['audit', '--omit=dev', '--audit-level=high'], {
      cwd: repoCwd,
      stdio: verbose ? 'inherit' : 'pipe',
      env: process.env,
    });
    if (auditRes.status !== 0) {
      logErr('FAIL npm audit --omit=dev --audit-level=high (high/critical vulnerabilities detected)');
      return {
        success: false,
        failedStep: 'npm:audit',
        error: 'npm audit failed',
        status: auditRes.status,
      };
    }
    log('PASS npm audit');
  }

  // Step 7: Complete verify:public-ready gate
  if (!options.skipPublicReady) {
    log('RUN npm run verify:public-ready');
    const readyRes = options.mockPublicReadyResult ?? spawnSync('npm', ['run', 'verify:public-ready'], {
      cwd: repoCwd,
      stdio: verbose ? 'inherit' : 'pipe',
      env: process.env,
    });
    if (readyRes.status !== 0) {
      logErr('FAIL verify:public-ready');
      return {
        success: false,
        failedStep: 'verify:public-ready',
        error: 'public-ready verifier failed',
        status: readyRes.status,
      };
    }
    log('PASS verify:public-ready');
  }

  log('PUBLIC_RELEASE_GATE=PASS');
  return {
    success: true,
    failedStep: null,
    publicReadySkipped: Boolean(options.skipPublicReady),
    cleanExportSkipped: Boolean(options.skipCleanExport),
  };
}

export function parseArgs(args = []) {
  const isJson = args.includes('--json');
  const skipPublicReady = args.includes('--skip-public-ready');
  const skipCleanExport = args.includes('--skip-clean-export');

  let targetCwd = process.cwd();
  const cwdIndex = args.indexOf('--cwd');
  if (cwdIndex !== -1 && args[cwdIndex + 1]) {
    targetCwd = path.resolve(args[cwdIndex + 1]);
  }

  return {
    cwd: targetCwd,
    skipPublicReady,
    skipCleanExport,
    json: isJson,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));

  verifyPublicRelease(parsed)
    .then((res) => {
      if (parsed.json) {
        console.log(JSON.stringify(res, null, 2));
      }
      if (!res.success) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(`PUBLIC_RELEASE_GATE=FAIL: ${err.message}`);
      process.exit(1);
    });
}
