import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PATTERNS = [
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/g],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['service account JSON', /["']type["']\s*:\s*["']service_account["']/g],
  ['refresh token value', /refresh[_-]?token\s*[:=]\s*["']?(?:1\/\/|ya29\.|[0-9A-Za-z_-]{40,})[0-9A-Za-z._~/-]*/gi],
  ['Firebase token value', /FIREBASE_TOKEN\s*=\s*[0-9A-Za-z._~/-]{20,}/g],
  ['GitHub token', /gh[oprsu]_[0-9A-Za-z]{30,}/g],
];

export function findSecretFindings(text, filename = '') {
  const findings = [];
  if (/^(?:service[-_.]?account|.*firebase-adminsdk.*)\.json$/i.test(path.basename(filename))) findings.push('sensitive credential filename');
  for (const [name, pattern] of PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(name);
  }
  return findings;
}

export function isGitRepo(cwd) {
  if (fs.existsSync(path.join(cwd, 'PUBLIC_EXPORT_MANIFEST.sha256')) && !fs.existsSync(path.join(cwd, '.git'))) {
    return false;
  }
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

export function parseAndVerifyManifest(cwd) {
  const manifestPath = path.join(cwd, 'PUBLIC_EXPORT_MANIFEST.sha256');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Refusing to scan secrets in non-Git directory without valid PUBLIC_EXPORT_MANIFEST.sha256: ${cwd}`
    );
  }

  const manifestContent = fs.readFileSync(manifestPath, 'utf8');
  const lines = manifestContent.split('\n');
  const files = [];
  const resolvedCwd = path.resolve(cwd);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (!match) {
      throw new Error(`Invalid manifest entry in ${manifestPath}: ${rawLine}`);
    }

    const [, expectedHash, relPath] = match;

    if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith('/') || relPath.startsWith('\\')) {
      throw new Error(`Absolute path forbidden in manifest: ${relPath}`);
    }

    const segments = relPath.split(/[/\\]/);
    if (segments.includes('..') || segments.includes('.')) {
      throw new Error(`Path traversal forbidden in manifest: ${relPath}`);
    }

    const normalizedRel = path.normalize(relPath).replace(/\\/g, '/');
    if (normalizedRel.startsWith('../') || normalizedRel === '..') {
      throw new Error(`Path traversal forbidden in manifest: ${relPath}`);
    }

    const absPath = path.resolve(cwd, relPath);
    if (!absPath.startsWith(resolvedCwd + path.sep)) {
      throw new Error(`Path escapes directory boundary: ${relPath}`);
    }

    if (!fs.existsSync(absPath)) {
      throw new Error(`Manifest-listed file does not exist: ${relPath}`);
    }

    const stat = fs.statSync(absPath);
    if (!stat.isFile()) {
      throw new Error(`Manifest-listed path is not a file: ${relPath}`);
    }

    const buffer = fs.readFileSync(absPath);
    const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actualHash !== expectedHash) {
      throw new Error(`Manifest hash mismatch for ${relPath}: expected ${expectedHash}, got ${actualHash}`);
    }

    files.push(relPath);
  }

  if (files.length === 0) {
    throw new Error(`Manifest contained zero valid file entries: ${manifestPath}`);
  }

  return files;
}

export function candidateFiles(cwd) {
  if (isGitRepo(cwd)) {
    const output = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return output.split('\0').filter(Boolean);
  }

  return parseAndVerifyManifest(cwd);
}

export function scanRepository(cwd = process.cwd()) {
  const findings = [];
  for (const relative of candidateFiles(cwd)) {
    const absolute = path.join(cwd, relative);
    let stat;
    try { stat = fs.statSync(absolute); } catch { continue; }
    if (!stat.isFile() || stat.size > 2_000_000) continue;
    const buffer = fs.readFileSync(absolute);
    if (buffer.includes(0)) continue;
    const matches = findSecretFindings(buffer.toString('utf8'), relative);
    for (const match of matches) findings.push(`${relative}: ${match}`);
  }
  return findings;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const findings = scanRepository();
  if (findings.length) {
    console.error('Secret scan failed:\n' + findings.map((x) => `- ${x}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Secret scan passed.');
  }
}
