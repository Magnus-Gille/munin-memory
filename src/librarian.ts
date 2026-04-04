import type Database from "better-sqlite3";
import {
  getConfiguredLegacyBearerTransportType,
  getContextMaxClassification,
  getContextTransportType,
  namespaceMatchesPattern,
  type AccessContext,
  type PrincipalType,
} from "./access.js";
import type {
  ClassificationLevel,
  EntryType,
  LibrarianRuntimeSummary,
  RedactedSourcesSummary,
  TransportType,
} from "./types.js";

export interface NamespaceClassificationFloor {
  namespace_pattern: string;
  min_classification: ClassificationLevel;
  created_at?: string;
  updated_at?: string;
}

export interface RedactableEntryMetadata {
  id: string;
  namespace: string;
  key?: string | null;
  entry_type?: EntryType;
  classification: ClassificationLevel;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

export type ClassificationEnforcementResult =
  | {
      allowed: true;
      maxClassification: ClassificationLevel;
      transportType: TransportType;
    }
  | {
      allowed: false;
      maxClassification: ClassificationLevel;
      transportType: TransportType;
      response: Record<string, unknown>;
    };

export interface FilteredRedactedSource<T> {
  source: T;
  metadata: RedactableEntryMetadata;
  response: Record<string, unknown>;
}

export interface ClassificationSourceFilterResult<T> {
  allowed: T[];
  redacted: FilteredRedactedSource<T>[];
}

export interface ResolveExplicitClassificationOptions {
  classification?: string | null;
  tags?: string[] | null;
}

export interface ResolveStoredClassificationOptions {
  namespace: string;
  namespaceFloor: ClassificationLevel;
  explicitClassification?: ClassificationLevel;
  existingClassification?: string | null;
  allowBelowFloorOverride?: boolean;
}

export interface LibrarianRuntimeConfig {
  transportMode?: string;
  librarianEnabled?: boolean;
  hasLegacyBearerCredential?: boolean;
  hasDpaBearerCredential?: boolean;
  legacyBearerTransportType?: TransportType;
}

export interface ResolvedStoredClassification {
  classification: ClassificationLevel;
  usedOverride: boolean;
  source: "explicit" | "existing" | "namespace-floor";
}

export const CLASSIFICATION_LEVELS = [
  "public",
  "internal",
  "client-confidential",
  "client-restricted",
] as const;

export const TRANSPORT_TYPES = ["local", "dpa_covered", "consumer"] as const;

export const CLASSIFICATION_TAG_PREFIX = "classification:";
export const FALLBACK_RESTRICTED_CLASSIFICATION: ClassificationLevel = "client-restricted";
export const DEFAULT_CLASSIFICATION_FLOOR: ClassificationLevel = "internal";

export const DEFAULT_NAMESPACE_CLASSIFICATION_FLOORS: Array<{
  pattern: string;
  minClassification: ClassificationLevel;
}> = [
  { pattern: "clients/*", minClassification: "client-confidential" },
  { pattern: "people/*", minClassification: "client-confidential" },
  { pattern: "business/*", minClassification: "client-confidential" },
  { pattern: "projects/*", minClassification: "internal" },
  { pattern: "decisions/*", minClassification: "internal" },
  { pattern: "meta/*", minClassification: "internal" },
  { pattern: "documents/*", minClassification: "internal" },
  { pattern: "users/*", minClassification: "internal" },
  { pattern: "shared/*", minClassification: "internal" },
  { pattern: "signals/*", minClassification: "internal" },
  { pattern: "digests/*", minClassification: "internal" },
  { pattern: "tasks/*", minClassification: "internal" },
  { pattern: "briefings/*", minClassification: "internal" },
  { pattern: "rituals/*", minClassification: "internal" },
  { pattern: "reading/*", minClassification: "public" },
  { pattern: "demo/*", minClassification: "public" },
];

export const PRINCIPAL_TYPE_DEFAULT_CLASSIFICATION: Record<PrincipalType, ClassificationLevel> = {
  owner: "client-restricted",
  family: "internal",
  agent: "internal",
  external: "public",
};

export const TRANSPORT_CLASSIFICATION_CEILINGS: Record<TransportType, ClassificationLevel> = {
  local: "client-restricted",
  dpa_covered: "client-confidential",
  consumer: "internal",
};

const CLASSIFICATION_RANKS: Record<ClassificationLevel, number> = {
  public: 0,
  internal: 1,
  "client-confidential": 2,
  "client-restricted": 3,
};

export function isClassificationLevel(value: unknown): value is ClassificationLevel {
  return typeof value === "string" && CLASSIFICATION_LEVELS.includes(value as ClassificationLevel);
}

export function isTransportType(value: unknown): value is TransportType {
  return typeof value === "string" && TRANSPORT_TYPES.includes(value as TransportType);
}

export function getClassificationRank(classification: ClassificationLevel): number {
  return CLASSIFICATION_RANKS[classification];
}

export function compareClassificationLevels(a: ClassificationLevel, b: ClassificationLevel): number {
  return getClassificationRank(a) - getClassificationRank(b);
}

export function classificationAllowed(
  entryClassification: ClassificationLevel,
  maxClassification: ClassificationLevel,
): boolean {
  return compareClassificationLevels(entryClassification, maxClassification) <= 0;
}

export function isLibrarianEnabled(): boolean {
  return (process.env.MUNIN_LIBRARIAN_ENABLED ?? "false") === "true";
}

export function isRedactionLogEnabled(): boolean {
  return (process.env.MUNIN_REDACTION_LOG_ENABLED ?? "true") !== "false";
}

export function getLibrarianConfigWarnings(
  options: LibrarianRuntimeConfig = {},
): string[] {
  const transportMode = options.transportMode ?? process.env.MUNIN_TRANSPORT ?? "stdio";
  const librarianEnabled = options.librarianEnabled ?? isLibrarianEnabled();
  const hasLegacyBearerCredential = options.hasLegacyBearerCredential ?? Boolean(process.env.MUNIN_API_KEY?.trim());
  const hasDpaBearerCredential = options.hasDpaBearerCredential ?? Boolean(process.env.MUNIN_API_KEY_DPA?.trim());
  const legacyBearerTransportType = options.legacyBearerTransportType ?? getConfiguredLegacyBearerTransportType();

  const warnings: string[] = [];
  if (!librarianEnabled) {
    warnings.push("MUNIN_LIBRARIAN_ENABLED is false; classification enforcement is disabled.");
  }

  const hasLegacyDpaFallback = hasLegacyBearerCredential && legacyBearerTransportType !== "consumer";
  if (transportMode === "http" && !hasDpaBearerCredential && !hasLegacyDpaFallback) {
    warnings.push(
      "No HTTP bearer credential currently resolves to dpa_covered; configure MUNIN_API_KEY_DPA or set MUNIN_API_KEY with MUNIN_BEARER_TRANSPORT_TYPE=dpa_covered.",
    );
  }

  return warnings;
}

export function getClassificationTag(classification: ClassificationLevel): string {
  return `${CLASSIFICATION_TAG_PREFIX}${classification}`;
}

export function stripClassificationTags(tags: string[]): string[] {
  return tags.filter((tag) => !tag.startsWith(CLASSIFICATION_TAG_PREFIX));
}

export function syncClassificationTag(
  tags: string[],
  classification: ClassificationLevel,
): string[] {
  return [...stripClassificationTags(tags), getClassificationTag(classification)];
}

export function normalizeStoredClassification(value: unknown): ClassificationLevel {
  if (isClassificationLevel(value)) {
    return value;
  }
  return FALLBACK_RESTRICTED_CLASSIFICATION;
}

export function parseExplicitClassification(
  options: ResolveExplicitClassificationOptions,
): ClassificationLevel | undefined {
  const { classification } = options;
  const tags = options.tags ?? [];
  const tagLevels = [...new Set(
    tags
      .filter((tag) => tag.startsWith(CLASSIFICATION_TAG_PREFIX))
      .map((tag) => tag.slice(CLASSIFICATION_TAG_PREFIX.length)),
  )];

  const invalidTagLevels = tagLevels.filter((value) => !isClassificationLevel(value));
  if (invalidTagLevels.length > 0) {
    throw new Error(
      `Invalid classification tag(s): ${invalidTagLevels.map((value) => `"classification:${value}"`).join(", ")}.`,
    );
  }

  if (tagLevels.length > 1) {
    throw new Error(
      `Multiple classification tags found: ${tagLevels.map((value) => `"classification:${value}"`).join(", ")}.`,
    );
  }

  let paramLevel: ClassificationLevel | undefined;
  if (classification !== undefined && classification !== null) {
    if (!isClassificationLevel(classification)) {
      throw new Error(
        `Invalid classification "${classification}". Expected one of: ${CLASSIFICATION_LEVELS.join(", ")}.`,
      );
    }
    paramLevel = classification;
  }

  const tagLevel = tagLevels[0] as ClassificationLevel | undefined;
  if (paramLevel && tagLevel && paramLevel !== tagLevel) {
    throw new Error(
      `classification parameter "${paramLevel}" conflicts with tag "${getClassificationTag(tagLevel)}".`,
    );
  }

  return paramLevel ?? tagLevel;
}

export function validateClassificationPattern(pattern: string): void {
  if (pattern === "*") return;

  if (pattern.includes("*")) {
    if (!pattern.endsWith("/*")) {
      throw new Error(
        `Invalid classification pattern "${pattern}". Patterns containing "*" must be "*" or end with "/*".`,
      );
    }
    if (pattern.slice(0, -1).includes("*")) {
      throw new Error(
        `Invalid classification pattern "${pattern}". Only a single trailing "*" is allowed.`,
      );
    }
  }
}

function getPatternSpecificity(pattern: string): number {
  if (pattern === "*") return 0;
  if (pattern.endsWith("/*")) return pattern.length - 1;
  return pattern.length + 1_000;
}

export function getConfiguredDefaultClassificationFloor(): ClassificationLevel {
  const configured = process.env.MUNIN_CLASSIFICATION_DEFAULT?.trim();
  if (configured && isClassificationLevel(configured)) {
    return configured;
  }
  return DEFAULT_CLASSIFICATION_FLOOR;
}

export function resolveNamespaceClassificationFloorFromRows(
  namespace: string,
  rows: NamespaceClassificationFloor[],
  fallback = getConfiguredDefaultClassificationFloor(),
): ClassificationLevel {
  let best = fallback;
  let bestSpecificity = -1;

  for (const row of rows) {
    if (!namespaceMatchesPattern(namespace, row.namespace_pattern)) continue;
    const specificity = getPatternSpecificity(row.namespace_pattern);
    const classification = normalizeStoredClassification(row.min_classification);
    if (specificity > bestSpecificity) {
      best = classification;
      bestSpecificity = specificity;
      continue;
    }
    if (specificity === bestSpecificity && compareClassificationLevels(classification, best) > 0) {
      best = classification;
    }
  }

  return best;
}

export function listNamespaceClassificationFloors(
  db: Database.Database,
): NamespaceClassificationFloor[] {
  return db.prepare(
    `SELECT namespace_pattern, min_classification, created_at, updated_at
     FROM namespace_classification
     ORDER BY LENGTH(namespace_pattern) DESC, namespace_pattern ASC`,
  ).all() as NamespaceClassificationFloor[];
}

export function resolveNamespaceClassificationFloor(
  db: Database.Database,
  namespace: string,
): ClassificationLevel {
  return resolveNamespaceClassificationFloorFromRows(
    namespace,
    listNamespaceClassificationFloors(db),
  );
}

export function resolveStoredClassification(
  options: ResolveStoredClassificationOptions,
): ResolvedStoredClassification {
  const {
    namespace,
    namespaceFloor,
    explicitClassification,
    existingClassification,
    allowBelowFloorOverride = false,
  } = options;

  if (explicitClassification) {
    if (compareClassificationLevels(explicitClassification, namespaceFloor) < 0) {
      if (allowBelowFloorOverride) {
        return {
          classification: explicitClassification,
          usedOverride: true,
          source: "explicit",
        };
      }
      throw new Error(
        `Classification "${explicitClassification}" is below namespace floor "${namespaceFloor}" for "${namespace}".`,
      );
    }
    return {
      classification: explicitClassification,
      usedOverride: false,
      source: "explicit",
    };
  }

  if (existingClassification && isClassificationLevel(existingClassification)) {
    if (compareClassificationLevels(existingClassification, namespaceFloor) >= 0) {
      return {
        classification: existingClassification,
        usedOverride: false,
        source: "existing",
      };
    }
  }

  return {
    classification: namespaceFloor,
    usedOverride: false,
    source: "namespace-floor",
  };
}

function formatTransportLabel(transportType: TransportType): string {
  switch (transportType) {
    case "local":
      return "local stdio";
    case "dpa_covered":
      return "DPA-covered HTTP";
    case "consumer":
      return "consumer HTTP/OAuth";
  }
}

function buildOwnerAccessGuidance(transportType: TransportType): string {
  switch (transportType) {
    case "local":
      return "Access full content from a connection approved for this classification.";
    case "dpa_covered":
      return "Access full content from a local stdio session.";
    case "consumer":
      return "Access full content from a DPA-covered or local connection.";
  }
}

function buildOwnerFilteredSourceReason(
  transportType: TransportType,
  maxClassification: ClassificationLevel,
): string {
  return `Some sources were excluded because your current connection (${formatTransportLabel(transportType)}) allows up to ${maxClassification}. ${buildOwnerAccessGuidance(transportType)}`;
}

function buildOwnerRedactionReason(
  entryClassification: ClassificationLevel,
  transportType: TransportType,
  maxClassification: ClassificationLevel,
): string {
  return `This entry is classified as ${entryClassification}. Your current connection (${formatTransportLabel(transportType)}) allows up to ${maxClassification}. ${buildOwnerAccessGuidance(transportType)}`;
}

export function buildRedactedEntryResponse(
  ctx: AccessContext,
  entry: RedactableEntryMetadata,
): Record<string, unknown> {
  if (ctx.principalType === "owner") {
    const response: Record<string, unknown> = {
      id: entry.id,
      namespace: entry.namespace,
      classification: entry.classification,
      redacted: true,
      redaction_reason: buildOwnerRedactionReason(
        entry.classification,
        getContextTransportType(ctx),
        getContextMaxClassification(ctx),
      ),
    };
    if (entry.entry_type !== undefined) {
      response.entry_type = entry.entry_type;
    }
    if (entry.key !== undefined && entry.key !== null) {
      response.key = entry.key;
    }
    if (entry.tags !== undefined) {
      response.tags = entry.tags;
    }
    if (entry.created_at !== undefined) {
      response.created_at = entry.created_at;
    }
    if (entry.updated_at !== undefined) {
      response.updated_at = entry.updated_at;
    }
    return response;
  }

  return {
    namespace: entry.namespace,
    redacted: true,
    redaction_reason: "Some entries in this namespace exceed your classification level.",
  };
}

export function filterSourcesByClassification<T>(
  ctx: AccessContext,
  sources: T[],
  getMetadata: (source: T) => RedactableEntryMetadata,
): ClassificationSourceFilterResult<T> {
  if (!isLibrarianEnabled()) {
    return {
      allowed: [...sources],
      redacted: [],
    };
  }

  const allowed: T[] = [];
  const redacted: FilteredRedactedSource<T>[] = [];

  for (const source of sources) {
    const metadata = getMetadata(source);
    const enforcement = enforceClassification(ctx, metadata);
    if (enforcement.allowed) {
      allowed.push(source);
      continue;
    }

    redacted.push({
      source,
      metadata,
      response: enforcement.response,
    });
  }

  return { allowed, redacted };
}

export function summarizeRedactedSources(
  ctx: AccessContext,
  entries: RedactableEntryMetadata[],
): RedactedSourcesSummary | undefined {
  if (!isLibrarianEnabled() || entries.length === 0) {
    return undefined;
  }

  if (ctx.principalType === "owner") {
    return {
      count: entries.length,
      namespaces: [...new Set(entries.map((entry) => entry.namespace))].sort().slice(0, 10),
      reason: buildOwnerFilteredSourceReason(
        getContextTransportType(ctx),
        getContextMaxClassification(ctx),
      ),
    };
  }

  return {
    count: entries.length,
    reason: "Some sources exceeded your classification level.",
  };
}

export function buildLibrarianRuntimeSummary(
  ctx: AccessContext,
  options: {
    redactedDashboardCount?: number;
    redactedSourceCount?: number;
  } = {},
): LibrarianRuntimeSummary {
  const summary: LibrarianRuntimeSummary = {
    enabled: isLibrarianEnabled(),
    transport_type: getContextTransportType(ctx),
    max_classification: getContextMaxClassification(ctx),
  };

  if (options.redactedDashboardCount && options.redactedDashboardCount > 0) {
    summary.redacted_dashboard_count = options.redactedDashboardCount;
  }
  if (options.redactedSourceCount && options.redactedSourceCount > 0) {
    summary.redacted_source_count = options.redactedSourceCount;
  }
  if (ctx.principalType === "owner") {
    summary.access_guidance = buildOwnerAccessGuidance(getContextTransportType(ctx));
  }

  return summary;
}

export function enforceClassification(
  ctx: AccessContext,
  entry: RedactableEntryMetadata,
): ClassificationEnforcementResult {
  const transportType = getContextTransportType(ctx);
  const maxClassification = getContextMaxClassification(ctx);

  if (!isLibrarianEnabled() || classificationAllowed(entry.classification, maxClassification)) {
    return {
      allowed: true,
      maxClassification,
      transportType,
    };
  }

  return {
    allowed: false,
    maxClassification,
    transportType,
    response: buildRedactedEntryResponse(ctx, entry),
  };
}
