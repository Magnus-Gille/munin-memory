import type { SecurityResult } from "./types.js";

const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /sk-[a-zA-Z0-9]{20,}/, label: "API key (sk-...)" },
  { pattern: /ghp_[a-zA-Z0-9]{36,}/, label: "GitHub personal access token" },
  { pattern: /gho_[a-zA-Z0-9]{36,}/, label: "GitHub OAuth token" },
  { pattern: /github_pat_[a-zA-Z0-9_]{22,}/, label: "GitHub fine-grained PAT" },
  { pattern: /Bearer\s+[a-zA-Z0-9\-._~+/]{20,}=*/, label: "Bearer token" },
  { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, label: "Private key" },
  { pattern: /-----BEGIN\s+CERTIFICATE-----/, label: "Certificate" },
  { pattern: /AKIA[0-9A-Z]{16}/, label: "AWS access key" },
  { pattern: /password\s*[:=]\s*['"][^'"]{8,}['"]/i, label: "Inline password" },
  { pattern: /secret\s*[:=]\s*['"][^'"]{8,}['"]/i, label: "Inline secret" },
];

const NAMESPACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/;
const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const TAG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/;
const MAX_TAGS = 20;

export function scanForSecrets(content: string): SecurityResult {
  for (const { pattern, label } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      return {
        valid: false,
        error: `Content appears to contain a secret or credential (matched pattern: ${label}). Secrets should never be stored in memory. Remove the sensitive content and try again.`,
      };
    }
  }
  return { valid: true };
}

export function validateNamespace(namespace: string): SecurityResult {
  if (!namespace || typeof namespace !== "string") {
    return { valid: false, error: "Namespace is required and must be a non-empty string." };
  }
  if (!NAMESPACE_RE.test(namespace)) {
    return {
      valid: false,
      error: `Invalid namespace "${namespace}". Must match pattern: starts with alphanumeric, then alphanumeric/underscore/hyphen/slash only.`,
    };
  }
  return { valid: true };
}

export function validateKey(key: string): SecurityResult {
  if (!key || typeof key !== "string") {
    return { valid: false, error: "Key is required and must be a non-empty string." };
  }
  if (!KEY_RE.test(key)) {
    return {
      valid: false,
      error: `Invalid key "${key}". Must match pattern: starts with alphanumeric, then alphanumeric/underscore/hyphen only.`,
    };
  }
  return { valid: true };
}

export function validateContent(content: string, maxSize: number): SecurityResult {
  if (!content || typeof content !== "string") {
    return { valid: false, error: "Content is required and must be a non-empty string." };
  }
  if (content.length > maxSize) {
    return {
      valid: false,
      error: `Content exceeds maximum size of ${maxSize} characters (got ${content.length}).`,
    };
  }
  return { valid: true };
}

export function validateTags(tags: unknown): SecurityResult {
  if (tags === undefined || tags === null) {
    return { valid: true };
  }
  if (!Array.isArray(tags)) {
    return { valid: false, error: `Tags must be a JSON array of strings (e.g. ["decision", "active"]), got ${typeof tags}: ${JSON.stringify(tags)}` };
  }
  if (tags.length > MAX_TAGS) {
    return { valid: false, error: `Too many tags (max ${MAX_TAGS}, got ${tags.length}).` };
  }
  for (const tag of tags) {
    if (typeof tag !== "string" || !TAG_RE.test(tag)) {
      return {
        valid: false,
        error: `Invalid tag "${tag}". Each tag must start with alphanumeric, then alphanumeric/underscore/hyphen/colon only.`,
      };
    }
  }
  return { valid: true };
}

export function validateWriteInput(
  namespace: string,
  key: string,
  content: string,
  tags: unknown,
  maxContentSize: number,
): SecurityResult {
  const checks = [
    validateNamespace(namespace),
    validateKey(key),
    validateContent(content, maxContentSize),
    validateTags(tags),
    scanForSecrets(content),
  ];
  for (const check of checks) {
    if (!check.valid) return check;
  }
  return { valid: true };
}

export function validateLogInput(
  namespace: string,
  content: string,
  tags: unknown,
  maxContentSize: number,
): SecurityResult {
  const checks = [
    validateNamespace(namespace),
    validateContent(content, maxContentSize),
    validateTags(tags),
    scanForSecrets(content),
  ];
  for (const check of checks) {
    if (!check.valid) return check;
  }
  return { valid: true };
}
