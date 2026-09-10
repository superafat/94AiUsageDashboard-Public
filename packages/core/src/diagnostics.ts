export const ALLOWED_DIAGNOSTIC_CODES = [
  'refresh_failed',
  'not_logged_in',
  'rate_limited',
  'network_error',
  'permission_denied',
  'provider_unavailable',
  'provider_error',
] as const;

export const ALLOWED_DIAGNOSTIC_LABELS = [
  'refresh failed',
  'not logged in',
  'rate limited',
  'network error',
  'permission denied',
  'provider unavailable',
  'provider error',
] as const;

export type AllowedDiagnosticCode = (typeof ALLOWED_DIAGNOSTIC_CODES)[number];
export type AllowedDiagnosticLabel = (typeof ALLOWED_DIAGNOSTIC_LABELS)[number];
export type AllowedDiagnostic = AllowedDiagnosticCode | AllowedDiagnosticLabel;

export const ALLOWED_DIAGNOSTICS = new Set<string>([
  ...ALLOWED_DIAGNOSTIC_CODES,
  ...ALLOWED_DIAGNOSTIC_LABELS,
]);

export const SENSITIVE_PATTERN = /(?:\bBearer\s+\S+|\/(?:Users|home|var|tmp|etc|opt|private)\/[^\s"']+|[a-zA-Z]:\\[^\s"']+|\b(?:sk-(?:ant-|proj-)?[a-zA-Z0-9_-]{10,}|AIza[0-9A-Za-z-_]{35})\b|\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{20,}\b|\bgithub_pat_[a-zA-Z0-9_]{30,}\b|(?:access|refresh)[_-]?token\s*[=:]\s*\S+|(?:api[_-]?key)\s*[=:]\s*\S+)/i;

export function classifyDiagnostic(raw: unknown): AllowedDiagnosticLabel | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  // Direct allowlist match
  if (ALLOWED_DIAGNOSTICS.has(trimmed)) {
    // Return standard label
    if (trimmed === 'refresh_failed') return 'refresh failed';
    if (trimmed === 'not_logged_in') return 'not logged in';
    if (trimmed === 'rate_limited') return 'rate limited';
    if (trimmed === 'network_error') return 'network error';
    if (trimmed === 'permission_denied') return 'permission denied';
    if (trimmed === 'provider_unavailable') return 'provider unavailable';
    if (trimmed === 'provider_error') return 'provider error';
    return trimmed as AllowedDiagnosticLabel;
  }

  // Bounded classification without echoing upstream prose or sensitive material
  if (/login|auth|unauthori[sz]|credential|token|session/i.test(trimmed)) {
    return 'not logged in';
  }
  if (/rate|limit|429|quota/i.test(trimmed)) {
    return 'rate limited';
  }
  if (/network|econn|enotfound|offline|dns|timeout/i.test(trimmed)) {
    return 'network error';
  }
  if (/permission|forbidden|403/i.test(trimmed)) {
    return 'permission denied';
  }
  if (/unavailable|503|service/i.test(trimmed)) {
    return 'provider unavailable';
  }
  if (/refresh/i.test(trimmed)) {
    return 'refresh failed';
  }

  return 'refresh failed';
}

export function safeDiagnosticText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (SENSITIVE_PATTERN.test(trimmed)) {
    return classifyDiagnostic(trimmed) ?? 'refresh failed';
  }
  if (ALLOWED_DIAGNOSTICS.has(trimmed)) {
    return trimmed;
  }
  return classifyDiagnostic(trimmed) ?? 'refresh failed';
}
