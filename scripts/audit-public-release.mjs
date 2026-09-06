import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkBinaryFile,
  checkCredentialFilename,
  computeFileSha256Sync,
  findPolicyFindings,
  isBinaryExtension,
  isBinaryFile,
  isFileBinarySync,
} from './public-release-policy.mjs';

const DEFAULT_MAX_SIZE = 2_000_000;

function isGitRepo(cwd) {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getCandidateTreeFiles(cwd) {
  if (!isGitRepo(cwd)) {
    throw new Error(`Not a git repository: ${cwd}`);
  }
  try {
    const output = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' });
    return output.split('\0').filter(Boolean);
  } catch (err) {
    throw new Error(`git ls-files failed in ${cwd}: ${err.message}`);
  }
}

function getGitBlobSha256(cwd, sha) {
  const script = `
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const child = spawn('git', ['cat-file', 'blob', process.argv[1]], { stdio: ['ignore', 'pipe', 'pipe'] });
const hash = crypto.createHash('sha256');
child.stdout.on('data', chunk => hash.update(chunk));
child.on('close', code => {
  if (code === 0) {
    process.stdout.write(hash.digest('hex'));
    process.exit(0);
  } else {
    process.exit(code || 1);
  }
});
child.on('error', () => process.exit(1));
`;
  try {
    return execFileSync(process.execPath, ['-e', script, sha], { cwd, encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(`Failed to compute SHA-256 for git blob ${sha}: ${err.message}`);
  }
}

export function auditPublicTree(cwd = process.cwd(), options = {}) {
  const findings = [];
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE;
  const candidateFiles = getCandidateTreeFiles(cwd);

  for (const relPath of candidateFiles) {
    const absPath = path.join(cwd, relPath);
    let stat;
    try {
      stat = fs.lstatSync(absPath);
    } catch {
      findings.push({
        severity: 'BLOCKER',
        category: 'manual_review_required',
        path: relPath,
        detail: 'failed to inspect tracked path',
      });
      continue;
    }

    // Always check credential filename regardless of type/size
    const credFinding = checkCredentialFilename(relPath);
    if (credFinding) {
      findings.push(credFinding);
    }

    if (stat.isSymbolicLink()) {
      let target;
      try {
        target = fs.readlinkSync(absPath);
      } catch {
        findings.push({
          severity: 'BLOCKER',
          category: 'manual_review_required',
          path: relPath,
          detail: 'failed to inspect symlink target',
        });
        continue;
      }

      // Check if symlink target points outside repository
      const resolvedTarget = path.resolve(path.dirname(absPath), target);
      const relToCwd = path.relative(cwd, resolvedTarget);
      const isOutside = relToCwd.startsWith('..') || path.isAbsolute(relToCwd);

      if (isOutside) {
        findings.push({
          severity: 'BLOCKER',
          category: 'manual_review_required',
          path: relPath,
          detail: 'symlink target points outside repository',
        });
      }

      // Check if symlink target itself has credential filename
      const targetCred = checkCredentialFilename(target);
      if (targetCred && !credFinding) {
        findings.push({
          severity: 'BLOCKER',
          category: 'credential_filename',
          path: relPath,
          detail: 'symlink target matches credential filename pattern',
        });
      }

      // Check policy findings on target string (without dereferencing)
      const policyFindings = findPolicyFindings(target, relPath, options);
      for (const f of policyFindings) {
        if (f.category === 'credential_filename') continue;
        findings.push(f);
      }

      // Never read target file contents for symlinks
      continue;
    }

    if (!stat.isFile()) continue;

    if (stat.size > maxSizeBytes) {
      const isBinary = isFileBinarySync(absPath, relPath);
      if (isBinary) {
        const sha256 = computeFileSha256Sync(absPath);
        const binaryFinding = checkBinaryFile(sha256, relPath, options);
        if (binaryFinding) {
          findings.push(binaryFinding);
        }
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
      buffer = fs.readFileSync(absPath);
    } catch {
      findings.push({
        severity: 'BLOCKER',
        category: 'manual_review_required',
        path: relPath,
        detail: 'failed to read tracked file',
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

  return findings;
}

export function auditGitHistory(cwd = process.cwd(), options = {}) {
  if (!isGitRepo(cwd)) {
    throw new Error(`Not a git repository: ${cwd}`);
  }

  const findings = [];
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE;

  let revListOutput;
  try {
    revListOutput = execFileSync('git', ['-c', 'core.quotepath=false', 'rev-list', '--objects', '--all'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`git rev-list --objects --all failed: ${err.message}`);
  }

  if (!revListOutput.trim()) return [];

  let batchCheckOutput;
  try {
    batchCheckOutput = execFileSync(
      'git',
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize) %(rest)'],
      {
        cwd,
        input: revListOutput,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      },
    );
  } catch (err) {
    throw new Error(`git cat-file --batch-check failed: ${err.message}`);
  }

  const commitCache = new Map();
  function resolveCommit(sha) {
    if (commitCache.has(sha)) return commitCache.get(sha);
    try {
      const logOutput = execFileSync(
        'git',
        ['log', '--all', `--find-object=${sha}`, '--format=%H', '--reverse'],
        { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
      );
      const commit = logOutput.trim().split('\n')[0] || 'unknown';
      commitCache.set(sha, commit);
      return commit;
    } catch {
      commitCache.set(sha, 'unknown');
      return 'unknown';
    }
  }

  const seen = new Set();

  for (const line of batchCheckOutput.split('\n')) {
    if (!line) continue;
    const parts = line.split(' ');
    if (parts.length < 3) continue;

    const sha = parts[0];
    const type = parts[1];
    const size = parseInt(parts[2], 10);
    const blobPath = parts.slice(3).join(' ').trim();

    if (type !== 'blob' || !blobPath) continue;

    const key = `${sha}:${blobPath}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Check credential filename regardless of size
    const credFinding = checkCredentialFilename(blobPath);
    if (credFinding) {
      const commit = resolveCommit(sha);
      findings.push({ ...credFinding, commit });
    }

    if (size > maxSizeBytes) {
      const isBinary = isBinaryExtension(blobPath);
      if (isBinary) {
        const sha256 = getGitBlobSha256(cwd, sha);
        const binaryFinding = checkBinaryFile(sha256, blobPath, options);
        if (binaryFinding) {
          const commit = resolveCommit(sha);
          findings.push({ ...binaryFinding, commit });
        }
      } else {
        const commit = resolveCommit(sha);
        findings.push({
          severity: 'BLOCKER',
          category: 'manual_review_required',
          path: blobPath,
          commit,
          detail: `blob size (${size} bytes) exceeds limit of ${maxSizeBytes} bytes and requires manual review`,
        });
      }
      continue;
    }

    let buffer;
    try {
      buffer = execFileSync('git', ['cat-file', 'blob', sha], {
        cwd,
        maxBuffer: maxSizeBytes + 1024,
        encoding: 'buffer',
      });
    } catch (err) {
      throw new Error(`git cat-file blob ${sha} (${blobPath}) failed: ${err.message}`);
    }

    const binaryFinding = checkBinaryFile(buffer, blobPath, options);
    if (binaryFinding) {
      const commit = resolveCommit(sha);
      findings.push({ ...binaryFinding, commit });
      continue;
    }

    if (isBinaryFile(buffer, blobPath)) continue;

    const text = buffer.toString('utf8');
    const policyFindings = findPolicyFindings(text, blobPath, options);
    if (policyFindings.length > 0) {
      const commit = resolveCommit(sha);
      for (const f of policyFindings) {
        // Skip duplicate credential filename finding if already pushed above
        if (f.category === 'credential_filename' && credFinding) continue;
        findings.push({ ...f, commit });
      }
    }
  }

  return findings;
}

export function auditPublicRelease(cwd = process.cwd(), options = {}) {
  const treeFindings = auditPublicTree(cwd, options);
  const historyFindings = auditGitHistory(cwd, options);
  return {
    treeFindings,
    historyFindings,
    allFindings: [...treeFindings, ...historyFindings],
  };
}

export function formatFinding(f) {
  const commitPart = f.commit ? ` (commit: ${f.commit.slice(0, 7)})` : '';
  return `[${f.severity}] [${f.category}] ${f.path}${commitPart}: ${f.detail}`;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const treeOnly = args.includes('--tree-only');
  const historyOnly = args.includes('--history-only');

  let targetCwd = process.cwd();
  const cwdIndex = args.indexOf('--cwd');
  if (cwdIndex !== -1 && args[cwdIndex + 1]) {
    targetCwd = path.resolve(args[cwdIndex + 1]);
  }

  let findings = [];
  try {
    if (treeOnly) {
      findings = auditPublicTree(targetCwd);
    } else if (historyOnly) {
      findings = auditGitHistory(targetCwd);
    } else {
      const result = auditPublicRelease(targetCwd);
      findings = result.allFindings;
    }
  } catch (err) {
    if (isJson) {
      console.log(
        JSON.stringify(
          [
            {
              severity: 'BLOCKER',
              category: 'audit_error',
              path: '.',
              detail: err.message,
            },
          ],
          null,
          2,
        ),
      );
    } else {
      console.error(`Public release audit aborted with error: ${err.message}`);
    }
    process.exit(1);
  }

  if (isJson) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    if (findings.length > 0) {
      console.error(
        `Public release audit failed with ${findings.length} findings:\n` +
          findings.map((f) => `- ${formatFinding(f)}`).join('\n'),
      );
    } else {
      console.log('Public release audit passed (0 findings).');
    }
  }

  if (findings.length > 0) {
    process.exitCode = 1;
  }
}
