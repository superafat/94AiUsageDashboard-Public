import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
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

const HEX_COMMIT_40_REGEX = /^[0-9a-fA-F]{40}$/;

// Public Git history reviewed through this commit. Existing metadata is preserved as history;
// every newer public-source commit must use a non-personal GitHub noreply identity.
export const PUBLIC_COMMIT_METADATA_BASELINE = '11a4e998ff36a12e7a7882f0ba1c4ce864acc3bc';
const SAFE_PUBLIC_GIT_EMAIL = /^(?:[^@\s]+@users\.noreply\.github\.com|noreply@github\.com)$/i;

function gitText(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function isCanonicalPublicRemote(cwd) {
  try {
    const origin = gitText(cwd, ['remote', 'get-url', 'origin']);
    return /(?:github\.com[:/])superafat\/94AiUsageDashboard-Public(?:\.git)?$/i.test(origin);
  } catch {
    return false;
  }
}

function baselineTracksPublicManifest(cwd, baseline) {
  try {
    execFileSync('git', ['cat-file', '-e', `${baseline}:PUBLIC_EXPORT_MANIFEST.sha256`], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function auditPublicCandidateCommitMetadata(cwd, options = {}) {
  const repoCwd = path.resolve(cwd);
  const baselineRef = options.baselineRef ?? PUBLIC_COMMIT_METADATA_BASELINE;
  const candidateRef = options.candidateRef ?? process.env.PUBLIC_RELEASE_HEAD_SHA ?? 'HEAD';
  const knownPublicRemote = options.publicRepository === true || isCanonicalPublicRemote(repoCwd);
  let baseline;
  try {
    baseline = gitText(repoCwd, ['rev-parse', `${baselineRef}^{commit}`]);
  } catch {
    if (!knownPublicRemote) return { applicable: false, findings: [] };
    return {
      applicable: true,
      findings: [{ severity: 'BLOCKER', category: 'commit_metadata', path: 'git-history', commit: 'unknown', role: 'baseline' }],
    };
  }

  const baselineIsPublic = baselineTracksPublicManifest(repoCwd, baseline);
  if (!baselineIsPublic) {
    if (!knownPublicRemote) return { applicable: false, findings: [] };
    return {
      applicable: true,
      findings: [{ severity: 'BLOCKER', category: 'commit_metadata', path: 'git-history', commit: baseline, role: 'baseline-manifest' }],
    };
  }

  let candidate;
  try {
    candidate = gitText(repoCwd, ['rev-parse', `${candidateRef}^{commit}`]);
  } catch {
    return {
      applicable: true,
      findings: [{ severity: 'BLOCKER', category: 'commit_metadata', path: 'git-history', commit: 'unknown', role: 'candidate' }],
    };
  }

  try {
    execFileSync('git', ['merge-base', '--is-ancestor', baseline, candidate], { cwd: repoCwd, stdio: 'ignore' });
  } catch {
    return {
      applicable: true,
      findings: [{ severity: 'BLOCKER', category: 'commit_metadata', path: 'git-history', commit: candidate, role: 'ancestry' }],
    };
  }

  const range = `${baseline}..${candidate}`;
  const commits = gitText(repoCwd, ['rev-list', '--reverse', range]).split(/\r?\n/).filter(Boolean);
  const findings = [];
  for (const commit of commits) {
    const [authorEmail = '', committerEmail = ''] = gitText(repoCwd, ['show', '-s', '--format=%ae%n%ce', commit]).split(/\r?\n/);
    if (!SAFE_PUBLIC_GIT_EMAIL.test(authorEmail)) {
      findings.push({ severity: 'BLOCKER', category: 'commit_email', path: 'git-author', commit, role: 'author' });
    }
    if (!SAFE_PUBLIC_GIT_EMAIL.test(committerEmail)) {
      findings.push({ severity: 'BLOCKER', category: 'commit_email', path: 'git-committer', commit, role: 'committer' });
    }
  }
  return { applicable: true, baseline, candidate, findings };
}

/**
 * Checks if a finding is covered by an entry in the reviewed baseline.
 * Matches category, path, and commit (requiring complete valid 40-character hex commit identity and no prefix/fail-open behavior).
 */
export function matchesBaseline(finding, baselineEntry) {
  if (!finding || !baselineEntry) return false;
  if (finding.category !== baselineEntry.category) return false;
  if (finding.path !== baselineEntry.path) return false;

  if (!finding.commit || typeof finding.commit !== 'string') {
    return false;
  }
  if (!baselineEntry.commit || typeof baselineEntry.commit !== 'string') {
    return false;
  }

  const fCommit = finding.commit.trim();
  const bCommit = baselineEntry.commit.trim();
  if (!HEX_COMMIT_40_REGEX.test(fCommit) || !HEX_COMMIT_40_REGEX.test(bCommit)) {
    return false;
  }

  return fCommit.toLowerCase() === bCommit.toLowerCase();
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

  // Public-repository commit metadata gate. Private engineering repos and non-Git clean exports are not applicable.
  if (!options.skipCommitMetadata) {
    log('RUN audit:commit-metadata');
    const metadataAudit = options.mockCommitMetadataFindings
      ? { applicable: true, findings: options.mockCommitMetadataFindings }
      : auditPublicCandidateCommitMetadata(repoCwd, options);
    if (metadataAudit.findings.length > 0) {
      logErr(`FAIL audit:commit-metadata (${metadataAudit.findings.length} blockers detected)`);
      for (const finding of metadataAudit.findings) logErr(`  - ${formatBoundedFinding(finding)}`);
      return {
        success: false,
        failedStep: 'audit:commit-metadata',
        error: 'Unsafe public commit metadata detected',
        commitMetadataBlockersCount: metadataAudit.findings.length,
      };
    }
    log(metadataAudit.applicable ? 'PASS audit:commit-metadata' : 'PASS audit:commit-metadata (not applicable)');
  }

  // Step 3: Clean public export and export audit
  if (!options.skipExport) {
    log('RUN export:public');
    const isCallerExportDir = Boolean(options.exportOutDir);
    let ownedExportRoot;
    const tempExportDir = options.exportOutDir ?? (() => {
      ownedExportRoot = fs.mkdtempSync(path.join(os.tmpdir(), '94aiusage-public-release-'));
      return path.join(ownedExportRoot, 'export');
    })();
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
      if (!isCallerExportDir && ownedExportRoot && !options.keepExportDir && fs.existsSync(ownedExportRoot)) {
        try {
          fs.rmSync(ownedExportRoot, { recursive: true, force: true });
        } catch {
          // best-effort cleanup of the directory created by this verifier only
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
