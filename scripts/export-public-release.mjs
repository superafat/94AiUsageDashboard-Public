import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditPublicTree } from './audit-public-release.mjs';
import {
  checkBinaryFile,
  checkCredentialFilename,
  computeFileSha256Sync,
  findPolicyFindings,
  isBinaryFile,
  isFileBinarySync,
} from './public-release-policy.mjs';

export const DEFAULT_EXPORT_PATH = '/tmp/94aiusage-v0.1.2-public';

export function isUnsafeExportDirectory(targetPath, repoCwd = null) {
  if (!targetPath) return true;
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  const home = path.resolve(os.homedir());
  const sysTmp = path.resolve(os.tmpdir());

  const dangerous = new Set([
    root,
    home,
    sysTmp,
    '/tmp',
    '/private/tmp',
    '/var/tmp',
  ]);

  if (repoCwd) {
    dangerous.add(path.resolve(repoCwd));
  }

  if (dangerous.has(resolved)) {
    return true;
  }

  try {
    if (fs.existsSync(resolved)) {
      const realTarget = fs.realpathSync(resolved);
      if (realTarget === root) return true;
      if (fs.existsSync(home) && realTarget === fs.realpathSync(home)) return true;
      if (fs.existsSync(sysTmp) && realTarget === fs.realpathSync(sysTmp)) return true;
      if (fs.existsSync('/tmp') && realTarget === fs.realpathSync('/tmp')) return true;
      if (fs.existsSync('/private/tmp') && realTarget === fs.realpathSync('/private/tmp')) return true;
      if (fs.existsSync('/var/tmp') && realTarget === fs.realpathSync('/var/tmp')) return true;
      if (repoCwd && fs.existsSync(repoCwd) && realTarget === fs.realpathSync(repoCwd)) return true;
    }
  } catch {
    // ignore filesystem errors
  }

  return false;
}

export const DEFAULT_EXCLUDE_PATTERNS = [
  // 1. Git internal metadata
  /(?:^|\/)\.git(?:\/|$)/,
  // 2. Internal Superpowers ledger and workflows
  /(?:^|\/)\.superpowers(?:\/|$)/,
  // 3. Internal planning and spec documentation
  /(?:^|\/)docs\/superpowers(?:\/|$)/,
  // 4. Private evidence inventory and test acceptance reports
  /(?:^|\/)docs\/evidence(?:\/|$)/,
  // 5. Environment and secret files (allow only .env.example)
  /(?:^|\/)\.env(?:\.(?!example)[a-zA-Z0-9._-]+)?$/,
  // 6. Local Firebase state and debug logs
  /(?:^|\/)(?:\.firebase|firebase-debug\.log.*|firestore-debug\.log.*)(?:\/|$)/,
  // 7. Local dependencies and package caches
  /(?:^|\/)node_modules(?:\/|$)/,
  // 8. Test execution artifacts and reports
  /(?:^|\/)(?:test-results|playwright-report|coverage|\.nyc_output)(?:\/|$)/,
  // 9. Build and lint tool caches
  /(?:^|\/)(?:\.cache|\.turbo|\.vite|\.eslintcache)(?:\/|$)/,
  // 10. Log files
  /\.log(?:\..*)?$/,
  // 11. OS metadata
  /(?:^|\/)\.DS_Store$/,
];

export function isExcludedPath(relPath, customPatterns = DEFAULT_EXCLUDE_PATTERNS) {
  const normalized = relPath.replace(/\\/g, '/');
  return customPatterns.some((pattern) => pattern.test(normalized));
}

export function filterExportFiles(trackedFiles, customPatterns = DEFAULT_EXCLUDE_PATTERNS) {
  return trackedFiles.filter((relPath) => !isExcludedPath(relPath, customPatterns));
}

export function generateManifest(exportDir, files, sourceCommitSha) {
  const sortedFiles = [...files]
    .filter((f) => f !== 'PUBLIC_EXPORT_MANIFEST.sha256')
    .sort((a, b) => a.localeCompare(b));

  const lines = [`# source_commit: ${sourceCommitSha}`];
  for (const relPath of sortedFiles) {
    const absPath = path.join(exportDir, relPath);
    const hash = computeFileSha256Sync(absPath);
    lines.push(`${hash}  ${relPath.replace(/\\/g, '/')}`);
  }

  const manifestContent = lines.join('\n') + '\n';
  const manifestPath = path.join(exportDir, 'PUBLIC_EXPORT_MANIFEST.sha256');
  fs.writeFileSync(manifestPath, manifestContent, 'utf8');

  return { manifestPath, manifestContent };
}

export function auditExportDirectory(exportDir, options = {}) {
  const maxSizeBytes = options.maxSizeBytes ?? 2_000_000;
  if (!fs.existsSync(exportDir)) {
    throw new Error(`Export directory does not exist: ${exportDir}`);
  }

  const resolved = path.resolve(exportDir);
  if (isUnsafeExportDirectory(resolved)) {
    throw new Error(`Refusing to audit unsafe directory: ${resolved}`);
  }

  if (fs.existsSync(path.join(resolved, '.git'))) {
    throw new Error(`Public export directory must not contain .git: ${resolved}`);
  }

  const findings = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(resolved, fullPath).replace(/\\/g, '/');

      const credFinding = checkCredentialFilename(relPath);
      if (credFinding) {
        findings.push(credFinding);
      }

      if (entry.isSymbolicLink()) {
        findings.push({
          severity: 'BLOCKER',
          category: 'manual_review_required',
          path: relPath,
          detail: 'symlink in public export requires manual review',
        });
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      // Manifest itself records file paths and hashes, skip self-scan
      if (relPath === 'PUBLIC_EXPORT_MANIFEST.sha256') {
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (err) {
        findings.push({
          severity: 'BLOCKER',
          category: 'manual_review_required',
          path: relPath,
          detail: `failed to stat file: ${err.message}`,
        });
        continue;
      }

      if (stat.size > maxSizeBytes) {
        const isBinary = isFileBinarySync(fullPath, relPath);
        if (isBinary) {
          const sha256 = computeFileSha256Sync(fullPath);
          const binaryFinding = checkBinaryFile(sha256, relPath, options);
          if (binaryFinding) findings.push(binaryFinding);
        } else {
          findings.push({
            severity: 'BLOCKER',
            category: 'manual_review_required',
            path: relPath,
            detail: `file size (${stat.size} bytes) exceeds limit of ${maxSizeBytes} bytes and requires manual review`,
          });
        }
        continue;
      }

      let buffer;
      try {
        buffer = fs.readFileSync(fullPath);
      } catch (err) {
        findings.push({
          severity: 'BLOCKER',
          category: 'manual_review_required',
          path: relPath,
          detail: `failed to read file: ${err.message}`,
        });
        continue;
      }

      const binaryFinding = checkBinaryFile(buffer, relPath, options);
      if (binaryFinding) {
        findings.push(binaryFinding);
        continue;
      }

      if (isBinaryFile(buffer, relPath)) continue;

      const text = buffer.toString('utf8');
      const policyFindings = findPolicyFindings(text, relPath, options);
      for (const f of policyFindings) {
        if (f.category === 'credential_filename' && credFinding) continue;
        findings.push(f);
      }
    }
  }

  walk(resolved);
  return findings;
}

export function exportPublicRelease(options = {}) {
  const repoCwd = path.resolve(options.cwd ?? process.cwd());
  const outDir = path.resolve(options.outDir ?? DEFAULT_EXPORT_PATH);
  const copyFileSync = options.copyFileSync ?? fs.copyFileSync;

  let insideWorkTree;
  try {
    insideWorkTree = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error('Not a git repository: public export requires a Git working tree');
  }
  if (insideWorkTree !== 'true') {
    throw new Error('Not a git repository: public export requires a Git working tree');
  }

  let trackedStatus;
  try {
    trackedStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: repoCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error('Export blocked: unable to verify clean Git working tree');
  }
  if (trackedStatus.trim()) {
    throw new Error('Export blocked: working tree has tracked or staged uncommitted changes');
  }

  // Step 1: Pre-export source tree audit - fail closed if blockers exist
  const treeFindings = auditPublicTree(repoCwd, options);
  const treeBlockers = treeFindings.filter((f) => f.severity === 'BLOCKER');
  if (treeBlockers.length > 0) {
    const summary = treeBlockers.map((f) => `[${f.category}] ${f.path}: ${f.detail}`).join('\n');
    throw new Error(`Export blocked: source tree audit found ${treeBlockers.length} blockers:\n${summary}`);
  }

  // Step 2: Resolve source commit SHA
  let sourceCommit = options.commitSha;
  if (!sourceCommit) {
    try {
      sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoCwd, encoding: 'utf8' }).trim();
    } catch (err) {
      throw new Error(`Unable to resolve git commit SHA in ${repoCwd}: ${err.message}`);
    }
  }

  // Step 3: Candidate files strictly from git ls-files
  let candidateFiles = options.trackedFiles;
  if (!candidateFiles) {
    try {
      const output = execFileSync('git', ['ls-files', '-z'], { cwd: repoCwd, encoding: 'utf8' });
      candidateFiles = output.split('\0').filter(Boolean);
    } catch (err) {
      throw new Error(`git ls-files failed in ${repoCwd}: ${err.message}`);
    }
  }

  // Step 4: Apply explicit reviewed include/exclude policy
  const excludePatterns = options.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS;
  const exportedRelFiles = filterExportFiles(candidateFiles, excludePatterns);

  // Step 5: Clean and prepare destination directory
  if (isUnsafeExportDirectory(outDir, repoCwd)) {
    throw new Error(`Refusing to export to unsafe directory: ${outDir}`);
  }
  let preparedOutDir = false;
  try {
    if (fs.existsSync(outDir)) {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outDir, { recursive: true });
    preparedOutDir = true;

    // Step 6: Copy files into export directory
    for (const relPath of exportedRelFiles) {
      const srcAbs = path.join(repoCwd, relPath);
      const destAbs = path.join(outDir, relPath);
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      copyFileSync(srcAbs, destAbs);
    }

    // Step 7: Generate deterministic SHA-256 manifest
    const { manifestPath, manifestContent } = generateManifest(outDir, exportedRelFiles, sourceCommit);

    // Step 8: Post-export audit against the non-git export directory
    const exportFindings = auditExportDirectory(outDir, options);
    const exportBlockers = exportFindings.filter((f) => f.severity === 'BLOCKER');
    if (exportBlockers.length > 0) {
      throw new Error(`Export aborted: exported directory failed public audit with ${exportBlockers.length} blockers`);
    }

    return {
      success: true,
      outDir,
      sourceCommit,
      exportedFilesCount: exportedRelFiles.length,
      exportedFiles: exportedRelFiles,
      manifestPath,
      manifestContent,
      findings: [],
    };
  } catch (err) {
    if (preparedOutDir && fs.existsSync(outDir) && !isUnsafeExportDirectory(outDir, repoCwd)) {
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
    }
    throw err;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');

  let targetCwd = process.cwd();
  const cwdIndex = args.indexOf('--cwd');
  if (cwdIndex !== -1 && args[cwdIndex + 1]) {
    targetCwd = path.resolve(args[cwdIndex + 1]);
  }

  let targetOutDir = DEFAULT_EXPORT_PATH;
  const outIndex = args.indexOf('--out') !== -1 ? args.indexOf('--out') : args.indexOf('--out-dir');
  if (outIndex !== -1 && args[outIndex + 1]) {
    targetOutDir = path.resolve(args[outIndex + 1]);
  }

  try {
    const result = exportPublicRelease({
      cwd: targetCwd,
      outDir: targetOutDir,
    });

    if (isJson) {
      console.log(
        JSON.stringify(
          {
            success: true,
            outDir: result.outDir,
            sourceCommit: result.sourceCommit,
            exportedFilesCount: result.exportedFilesCount,
            manifestPath: result.manifestPath,
          },
          null,
          2,
        ),
      );
    } else {
      console.log('Public export completed successfully:');
      console.log(`- Target: ${result.outDir}`);
      console.log(`- Source commit: ${result.sourceCommit}`);
      console.log(`- Exported files: ${result.exportedFilesCount}`);
      console.log(`- Manifest: ${result.manifestPath}`);
    }
  } catch (err) {
    if (isJson) {
      console.log(
        JSON.stringify(
          {
            success: false,
            error: err.message,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`Public export failed: ${err.message}`);
    }
    process.exit(1);
  }
}
