import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecretFindings } from './scan-secrets.mjs';

const BINARY_EXTENSIONS = /\.(?:png|jpe?g|gif|ico|webp|bmp|tiff|pdf|zip|tar|gz|tgz|bz2|xz|7z|rar|dmg|pkg|iso|exe|dylib|so|dll)$/i;
const CREDENTIAL_FILENAME_PATTERN = /(?:^|\/)(?:\.env(?:\.(?!example)[a-zA-Z0-9._-]+)?|service[-_.]?account[^/]*\.json|credentials?\.json|firebase-adminsdk[^/]*\.json|id_rsa[^/]*|id_ed25519[^/]*|[^/]*\.(?:p12|pfx|pem))$/i;

const LOCAL_HOME_PATH_REGEX = /(?:^|[\s"'`=(:,])(?:\/Users\/[a-zA-Z0-9._-]+|\/home\/[a-zA-Z0-9._-]+)/;
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PRIVATE_FIREBASE_MARKER_REGEX = /(?:https:\/\/console\.firebase\.google\.com\/project\/(?!(?:YOUR_|your[-_]|demo\b|demo[-_]|example\b|example[-_]|test\b|test[-_]))[a-z0-9-]+|(?:^|[\s"'`=/])(?!(?:YOUR_|your[-_]|demo\b|demo[-_]|example\b|example[-_]|test\b|test[-_]|\*))([a-z0-9][a-z0-9-]*)\.(?:firebaseio\.com|web\.app|firebaseapp\.com)|projectId\s*:\s*["'`](?!(?:YOUR_|your[-_]|demo\b|demo[-_]|example\b|example[-_]|test\b|test[-_]|\$))[a-z0-9-]+["'`]|FIREBASE_PROJECT_ID\s*[:=]\s*["'`]?(?!(?:YOUR_|your[-_]|demo\b|demo[-_]|example\b|example[-_]|test\b|test[-_]|\$))[a-z0-9-]+["'`]?|\bprivate[-_]firebase[-_](?!marker\b)[a-z0-9-]+\b)/;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PRIVATE_RELEASE_BASELINE_PATH = path.resolve(
  MODULE_DIR,
  '../docs/evidence/v0.1.2-private-release-baseline.json',
);

export function loadPrivateReleaseBaseline(baselinePath = PRIVATE_RELEASE_BASELINE_PATH) {
  if (!fs.existsSync(baselinePath)) {
    return { schemaVersion: 1, history: [], reviewedBinaries: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch {
    throw new Error('Private release baseline is unreadable or invalid JSON');
  }

  if (
    parsed?.schemaVersion !== 1
    || !Array.isArray(parsed.history)
    || !Array.isArray(parsed.reviewedBinaries)
  ) {
    throw new Error('Private release baseline has an invalid schema');
  }

  for (const sha of parsed.reviewedBinaries) {
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/i.test(sha)) {
      throw new Error('Private release baseline contains an invalid binary SHA');
    }
  }

  const HEX_COMMIT_40_REGEX = /^[0-9a-f]{40}$/i;
  for (const entry of parsed.history) {
    if (
      !entry
      || typeof entry.category !== 'string' || !entry.category.trim()
      || typeof entry.path !== 'string' || !entry.path.trim()
      || typeof entry.reason !== 'string' || !entry.reason.trim()
      || typeof entry.commit !== 'string' || !HEX_COMMIT_40_REGEX.test(entry.commit.trim())
    ) {
      throw new Error('Private release baseline contains an invalid history entry: complete 40-character commit identity and category/path/reason required');
    }
  }

  return parsed;
}


const PRIVATE_RELEASE_BASELINE = loadPrivateReleaseBaseline();
export const PUBLIC_REVIEWED_BINARIES_PATH = path.resolve(MODULE_DIR, '../docs/readme-screenshots.sha256');

export function loadPublicReviewedBinaryShas(manifestPath = PUBLIC_REVIEWED_BINARIES_PATH) {
  if (!fs.existsSync(manifestPath)) return [];
  const shas = [];
  for (const rawLine of fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([0-9a-f]{64})\s{2}(docs\/images\/readme\/[A-Za-z0-9._-]+\.(?:png|jpe?g|webp))$/i);
    if (!match) throw new Error('Public reviewed-binary manifest contains an invalid entry');
    shas.push(match[1].toLowerCase());
  }
  return shas;
}

export const REVIEWED_BINARY_SHAS = new Set([
  ...PRIVATE_RELEASE_BASELINE.reviewedBinaries,
  ...loadPublicReviewedBinaryShas(),
]);

export function computeSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function isBinaryExtension(filename = '') {
  return BINARY_EXTENSIONS.test(filename);
}

export function isBinaryFile(buffer, filename = '') {
  if (BINARY_EXTENSIONS.test(filename)) return true;
  if (buffer && buffer.includes(0)) return true;
  return false;
}

export function isFileBinarySync(absPath, filename = '') {
  if (BINARY_EXTENSIONS.test(filename)) return true;
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
    return buf.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function computeFileSha256Sync(absPath) {
  const fd = fs.openSync(absPath, 'r');
  const hash = crypto.createHash('sha256');
  const buf = Buffer.alloc(65536);
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

export function checkCredentialFilename(filename) {
  const base = path.basename(filename);
  if (base === '.env.example') return null;
  if (CREDENTIAL_FILENAME_PATTERN.test(filename)) {
    return {
      severity: 'BLOCKER',
      category: 'credential_filename',
      path: filename,
      detail: 'credential filename pattern',
    };
  }
  return null;
}

export function checkBinaryFile(bufferOrSha, filename, options = {}) {
  let sha256;
  if (typeof bufferOrSha === 'string') {
    sha256 = bufferOrSha;
  } else {
    if (!isBinaryFile(bufferOrSha, filename)) return null;
    sha256 = computeSha256(bufferOrSha);
  }

  const allowlist = options.reviewedBinaries instanceof Set
    ? options.reviewedBinaries
    : new Set(options.reviewedBinaries ?? []);

  if (REVIEWED_BINARY_SHAS.has(sha256) || allowlist.has(sha256)) return null;

  return {
    severity: 'BLOCKER',
    category: 'manual_review_required',
    path: filename,
    detail: `binary file requires manual review (SHA-256: ${sha256})`,
  };
}

export function findPolicyFindings(text, filename = '') {
  const findings = [];

  // 1. Credential filenames
  const credFinding = checkCredentialFilename(filename);
  if (credFinding) findings.push(credFinding);

  // 2. Secret patterns from scan-secrets.mjs
  const secretMatches = findSecretFindings(text, filename);
  for (const match of secretMatches) {
    if (match === 'sensitive credential filename') {
      if (!credFinding) {
        findings.push({
          severity: 'BLOCKER',
          category: 'credential_filename',
          path: filename,
          detail: 'sensitive credential filename',
        });
      }
    } else {
      findings.push({
        severity: 'BLOCKER',
        category: 'secret',
        path: filename,
        detail: `detected ${match}`,
      });
    }
  }

  // 3. Local home paths
  if (LOCAL_HOME_PATH_REGEX.test(text)) {
    findings.push({
      severity: 'BLOCKER',
      category: 'local_home_path',
      path: filename,
      detail: 'local home directory path pattern',
    });
  }

  // 4. Email addresses (skip package-lock.json third-party upstream metadata)
  if (path.basename(filename) !== 'package-lock.json' && EMAIL_REGEX.test(text)) {
    findings.push({
      severity: 'BLOCKER',
      category: 'email_address',
      path: filename,
      detail: 'email address pattern',
    });
  }

  // 5. Private Firebase environment markers
  if (PRIVATE_FIREBASE_MARKER_REGEX.test(text)) {
    findings.push({
      severity: 'BLOCKER',
      category: 'private_firebase_marker',
      path: filename,
      detail: 'private Firebase project marker pattern',
    });
  }

  return findings;
}
