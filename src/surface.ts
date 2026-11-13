/**
 * Opt-in token-economy switches for the MCP tool surface (MUNIN-434).
 *
 * Every model call re-sends the full `tools/list` payload, and tool results are
 * re-sent on every later iteration of the same turn. Memory Arena traces (see
 * `benchmark/tool-surface/REPORT.md`) put tool definitions at ~62–66% and tool
 * results at ~22–27% of Munin's input tokens per question. Two server-level
 * switches reduce both without changing default behaviour:
 *
 * - `MUNIN_TOOL_PROFILE`: `full` (default) lists every tool; `core` lists the
 *   eight everyday tools; a comma-separated list of tool names lists exactly
 *   those. Tools outside the profile are neither listed nor callable.
 * - `MUNIN_RESPONSE_MODE`: `full` (default) or `compact`. Compact drops
 *   redundant timestamps, self-provenance, duplicated classification tags,
 *   routine retrieval diagnostics and write-ack echoes from `memory_query`,
 *   `memory_orient` and write acknowledgements.
 *
 * Compaction is a pure post-processing step over an already authorized,
 * already enveloped response: it only removes fields from a fixed allowlist
 * and never touches content, untrusted-content flags or envelopes, redaction
 * markers, expiry/synthesis markers, warnings, cursors, or error responses.
 */
import type { AccessContext } from "./access.js";

export const CORE_TOOL_NAMES = [
  "memory_orient",
  "memory_query",
  "memory_read",
  "memory_read_batch",
  "memory_write",
  "memory_update_status",
  "memory_log",
  "memory_attention",
] as const;

export const TOOL_PROFILE_ENV = "MUNIN_TOOL_PROFILE";
export const RESPONSE_MODE_ENV = "MUNIN_RESPONSE_MODE";

export type ResponseMode = "full" | "compact";

export interface ToolProfile {
  /** `full`, `core`, or `custom` for an explicit tool list. */
  name: "full" | "core" | "custom";
  /** Enabled tool names; `null` means every registered tool. */
  tools: ReadonlySet<string> | null;
}

type EnvLike = Record<string, string | undefined>;

/**
 * Resolve the tool profile. Unknown profile or tool names throw, so a typo
 * fails at startup instead of silently exposing a different surface.
 */
export function resolveToolProfile(registered: readonly string[], env: EnvLike = process.env): ToolProfile {
  const raw = env[TOOL_PROFILE_ENV]?.trim() ?? "";
  if (raw === "" || raw === "full") return { name: "full", tools: null };
  if (raw === "core") return { name: "core", tools: new Set(CORE_TOOL_NAMES) };
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const known = new Set(registered);
  const unknown = names.filter((n) => !known.has(n));
  if (names.length === 0 || unknown.length > 0) {
    throw new Error(
      `${TOOL_PROFILE_ENV} must be "full", "core", or a comma-separated list of tool names; unknown: ${unknown.join(", ") || raw}`,
    );
  }
  return { name: "custom", tools: new Set(names) };
}

export function resolveResponseMode(env: EnvLike = process.env): ResponseMode {
  const raw = env[RESPONSE_MODE_ENV]?.trim() ?? "";
  if (raw === "" || raw === "full") return "full";
  if (raw === "compact") return "compact";
  throw new Error(`${RESPONSE_MODE_ENV} must be "full" or "compact"; got "${raw}"`);
}

export function isToolEnabled(profile: ToolProfile, name: string): boolean {
  return profile.tools === null || profile.tools.has(name);
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Provenance that only restates the caller's own authorship carries no signal. */
function isSelfProvenance(prov: unknown, ctx: AccessContext): boolean {
  if (!isObj(prov)) return false;
  const keys = Object.keys(prov).filter((k) => prov[k] !== undefined);
  if (keys.some((k) => k !== "principal_id" && k !== "owner_principal_id")) return false;
  return prov.principal_id === ctx.principalId
    && (prov.owner_principal_id === undefined || prov.owner_principal_id === ctx.principalId);
}

function compactEntryMetadata(item: Json, ctx: AccessContext): void {
  // Keep `updated_at` (ISO, the CAS token and the date models reason over);
  // drop the derived/duplicate timestamps. `valid_until` is kept when set.
  delete item.updated_at_local;
  delete item.created_at;
  delete item.valid_from;
  if (item.valid_until === null) delete item.valid_until;
  if (isSelfProvenance(item.provenance, ctx)) delete item.provenance;
  // `classification` is the canonical field; the mirrored tag repeats it.
  if (typeof item.classification === "string" && Array.isArray(item.tags)) {
    const mirror = `classification:${item.classification}`;
    item.tags = item.tags.filter((t) => t !== mirror);
  }
}

function compactQuery(resp: Json, ctx: AccessContext): void {
  if (Array.isArray(resp.results)) {
    for (const r of resp.results) if (isObj(r) && !r.match) compactEntryMetadata(r, ctx);
  }
  const explain = Array.isArray(resp.results) && resp.results.some((r) => isObj(r) && r.match);
  if (explain) return; // explain:true asked for diagnostics; keep them.
  delete resp.total; // alias of total_matched
  delete resp.query; // echo of the caller's own argument
  delete resp.search_meta;
  if (isObj(resp.retrieval)) {
    // Keep only signals that change how results must be read: an explicit
    // degradation reason, truncated candidates (total_matched is a lower
    // bound), relaxed lexical matching, and hidden expired entries.
    const r = resp.retrieval;
    const kept: Json = {};
    if (r.fallback_reason != null) kept.fallback_reason = r.fallback_reason;
    if (r.relaxed_lexical === true) kept.relaxed_lexical = true;
    if (typeof r.expired_filtered_count === "number" && r.expired_filtered_count > 0) {
      kept.expired_filtered_count = r.expired_filtered_count;
    }
    if (r.candidates_truncated === true) {
      kept.candidates_truncated = true;
      if (r.candidate_cap !== undefined) kept.candidate_cap = r.candidate_cap;
    }
    if (Object.keys(kept).length > 0) resp.retrieval = kept;
    else delete resp.retrieval;
  }
  if (resp.redacted_count === 0) delete resp.redacted_count;
}

function compactOrient(resp: Json): void {
  if (isObj(resp.dashboard)) {
    for (const [group, items] of Object.entries(resp.dashboard)) {
      if (Array.isArray(items) && items.length === 0) {
        delete resp.dashboard[group]; // dashboard_meta.counts still reports zeros
        continue;
      }
      if (Array.isArray(items)) for (const it of items) if (isObj(it)) delete it.updated_at_local;
    }
  }
  if (Array.isArray(resp.maintenance_needed)) {
    // The per-item suggestion is boilerplate; namespace + issue carry the signal.
    for (const it of resp.maintenance_needed) if (isObj(it) && typeof it.issue === "string") delete it.suggestion;
  }
  const budget = resp.response_budget_meta;
  if (isObj(budget) && !(Array.isArray(budget.adjustments) && budget.adjustments.length > 0)) {
    delete resp.response_budget_meta;
  }
}

function compactWriteAck(resp: Json, ctx: AccessContext): void {
  delete resp.timestamp_local;
  if (resp.valid_until === null) delete resp.valid_until;
  if (isSelfProvenance(resp.provenance, ctx)) delete resp.provenance;
  // update_status echoes the rendered content and its parsed sections; keep the sections.
  if (isObj(resp.structured_status) && typeof resp.content === "string") delete resp.content;
  const intake = resp.intake;
  if (isObj(intake)) {
    delete intake.metadata;
    // Drop warnings that only repeat an intake flag already present in `intake.flags`.
    const flags = Array.isArray(intake.flags) ? intake.flags.filter(isObj) : [];
    const dup = new Set(flags.map((f) => `[intake:${String(f.check)}] ${String(f.message)}`));
    if (Array.isArray(resp.warnings)) {
      const left = resp.warnings.filter((w) => !(typeof w === "string" && dup.has(w)));
      if (left.length > 0) resp.warnings = left;
      else delete resp.warnings;
    }
  }
}

const COMPACTORS: Record<string, (resp: Json, ctx: AccessContext) => void> = {
  memory_query: compactQuery,
  memory_orient: (resp) => compactOrient(resp),
  memory_write: compactWriteAck,
  memory_log: compactWriteAck,
  memory_update_status: compactWriteAck,
};

/**
 * Compact a successful JSON tool response in place of its text. Returns the
 * input unchanged for other tools, non-JSON text, and error responses.
 */
export function compactToolResponseText(toolName: string, text: string, ctx: AccessContext): string {
  const compactor = COMPACTORS[toolName];
  if (!compactor) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isObj(parsed) || parsed.ok !== true) return text;
  // validate_only previews and dry runs are inspection calls; keep them verbatim.
  if (parsed.dry_run === true || parsed.validate_only === true) return text;
  compactor(parsed, ctx);
  return JSON.stringify(parsed);
}
