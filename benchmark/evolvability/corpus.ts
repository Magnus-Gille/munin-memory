/**
 * Load and validate an evolvability corpus JSON file.
 *
 * Hand-rolled validation (no external schema-validator dependency, per repo
 * convention of minimal deps) that produces clear, actionable error messages
 * — every error is prefixed with the offending world's index and id (when
 * available) so a maintainer editing a corpus file can find the problem
 * immediately.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { World, Probe, RejectedOption, VerdictAction } from "./types.js";

const VALID_PROBE_KINDS: ReadonlySet<string> = new Set(["perturbation", "stasis"]);
const VALID_EXPECTED: ReadonlySet<string> = new Set<VerdictAction>([
  "REOPEN_SWITCH",
  "REOPEN_HOLD",
  "HOLD",
]);
const VALID_ATTACKS: ReadonlySet<string> = new Set(["rationale", "rejected-branch", "none"]);

export interface CorpusLoadResult {
  worlds: World[];
  path: string;
  sha256: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Fail with a message that names both the failing field and the world it came from. */
function fail(worldLabel: string, message: string): never {
  throw new Error(`Evolvability corpus: World ${worldLabel}: ${message}`);
}

function validateRejectedOption(
  raw: unknown,
  worldLabel: string,
  index: number,
): RejectedOption {
  if (!isPlainObject(raw)) {
    fail(worldLabel, `decision.rejected[${index}] must be an object with "option" and "reason" string fields.`);
  }
  if (!isNonEmptyString(raw.option)) {
    fail(worldLabel, `decision.rejected[${index}].option must be a non-empty string.`);
  }
  if (!isNonEmptyString(raw.reason)) {
    fail(worldLabel, `decision.rejected[${index}].reason must be a non-empty string (why this option was rejected).`);
  }
  return { option: raw.option, reason: raw.reason };
}

function validateDecision(raw: unknown, worldLabel: string): World["decision"] {
  if (!isPlainObject(raw)) {
    fail(worldLabel, `"decision" must be an object.`);
  }
  if (!isNonEmptyString(raw.title)) {
    fail(worldLabel, `decision.title must be a non-empty string.`);
  }
  if (!isNonEmptyString(raw.chosen)) {
    fail(worldLabel, `decision.chosen must be a non-empty string.`);
  }
  if (!isNonEmptyString(raw.rationale)) {
    fail(worldLabel, `decision.rationale must be a non-empty string.`);
  }
  if (!Array.isArray(raw.rejected) || raw.rejected.length === 0) {
    fail(
      worldLabel,
      `decision.rejected must be a non-empty array — evolvability probes need at least one ` +
        `rejected alternative to attack. Got: ${Array.isArray(raw.rejected) ? "empty array" : typeof raw.rejected}.`,
    );
  }
  const rejected = raw.rejected.map((r: unknown, i: number) => validateRejectedOption(r, worldLabel, i));
  if (!isStringArray(raw.load_bearing_conditions)) {
    fail(worldLabel, `decision.load_bearing_conditions must be an array of strings.`);
  }
  return {
    title: raw.title,
    chosen: raw.chosen,
    rationale: raw.rationale,
    rejected,
    load_bearing_conditions: raw.load_bearing_conditions,
  };
}

function validateMemory(raw: unknown, worldLabel: string): World["memory"] {
  if (!isPlainObject(raw)) {
    fail(worldLabel, `"memory" must be an object with "destination" and "path_logs" fields.`);
  }
  const destinationRaw = raw.destination;
  if (!isPlainObject(destinationRaw)) {
    fail(worldLabel, `memory.destination must be an object.`);
  }
  if (!isNonEmptyString(destinationRaw.namespace)) {
    fail(worldLabel, `memory.destination.namespace must be a non-empty string.`);
  }
  if (!isNonEmptyString(destinationRaw.key)) {
    fail(worldLabel, `memory.destination.key must be a non-empty string.`);
  }
  if (typeof destinationRaw.content !== "string" || destinationRaw.content.length === 0) {
    fail(worldLabel, `memory.destination.content must be a non-empty string.`);
  }
  if (!isStringArray(destinationRaw.tags)) {
    fail(worldLabel, `memory.destination.tags must be an array of strings.`);
  }

  const pathLogsRaw = raw.path_logs;
  if (!Array.isArray(pathLogsRaw) || pathLogsRaw.length === 0) {
    fail(
      worldLabel,
      `memory.path_logs must be a non-empty array — arm B (destination + path) has nothing ` +
        `to add over arm A without at least one path log entry.`,
    );
  }
  const pathLogs = pathLogsRaw.map((raw: unknown, i: number) => {
    if (!isPlainObject(raw)) {
      fail(worldLabel, `memory.path_logs[${i}] must be an object.`);
    }
    if (!isNonEmptyString(raw.namespace)) {
      fail(worldLabel, `memory.path_logs[${i}].namespace must be a non-empty string.`);
    }
    if (typeof raw.content !== "string" || raw.content.length === 0) {
      fail(worldLabel, `memory.path_logs[${i}].content must be a non-empty string.`);
    }
    if (!isStringArray(raw.tags)) {
      fail(worldLabel, `memory.path_logs[${i}].tags must be an array of strings.`);
    }
    if (!isNonEmptyString(raw.ts)) {
      fail(worldLabel, `memory.path_logs[${i}].ts must be a non-empty ISO 8601 timestamp string.`);
    }
    return { namespace: raw.namespace, content: raw.content, tags: raw.tags, ts: raw.ts };
  });

  return {
    destination: {
      namespace: destinationRaw.namespace,
      key: destinationRaw.key,
      content: destinationRaw.content,
      tags: destinationRaw.tags,
    },
    path_logs: pathLogs,
  };
}

function validateProbe(raw: unknown, worldLabel: string, index: number): Probe {
  if (!isPlainObject(raw)) {
    fail(worldLabel, `probes[${index}] must be an object.`);
  }
  if (!isNonEmptyString(raw.id)) {
    fail(worldLabel, `probes[${index}].id must be a non-empty string.`);
  }
  if (typeof raw.kind !== "string" || !VALID_PROBE_KINDS.has(raw.kind)) {
    fail(
      worldLabel,
      `probes[${index}].kind must be one of "perturbation" | "stasis" (got ${JSON.stringify(raw.kind)}).`,
    );
  }
  if (!isNonEmptyString(raw.text)) {
    fail(worldLabel, `probes[${index}].text must be a non-empty string.`);
  }
  if (typeof raw.expected !== "string" || !VALID_EXPECTED.has(raw.expected)) {
    fail(
      worldLabel,
      `probes[${index}].expected must be one of "REOPEN_SWITCH" | "REOPEN_HOLD" | "HOLD" ` +
        `(got ${JSON.stringify(raw.expected)}).`,
    );
  }
  if (typeof raw.attacks !== "string" || !VALID_ATTACKS.has(raw.attacks)) {
    fail(
      worldLabel,
      `probes[${index}].attacks must be one of "rationale" | "rejected-branch" | "none" ` +
        `(got ${JSON.stringify(raw.attacks)}). A perturbation must attack the rationale or a ` +
        `rejected branch, never the decision surface directly.`,
    );
  }
  if (raw.kind === "stasis" && raw.expected !== "HOLD") {
    fail(
      worldLabel,
      `probes[${index}] is kind "stasis" but expected is ${JSON.stringify(raw.expected)} — stasis ` +
        `controls must expect "HOLD" (they exist to catch an always-flip agent).`,
    );
  }
  return {
    id: raw.id,
    kind: raw.kind as Probe["kind"],
    text: raw.text,
    expected: raw.expected as VerdictAction,
    attacks: raw.attacks as Probe["attacks"],
  };
}

function validateWorld(raw: unknown, index: number): World {
  const positionalLabel = `[${index}]`;
  if (!isPlainObject(raw)) {
    fail(positionalLabel, `must be an object (got ${Array.isArray(raw) ? "array" : typeof raw}).`);
  }
  if (!isNonEmptyString(raw.id)) {
    fail(positionalLabel, `"id" must be a non-empty string.`);
  }
  // Re-derive the label including the id now that we know it's present, so every
  // subsequent error in this world is easy to locate by id, not just index.
  const worldLabel = `${positionalLabel} (id="${raw.id}")`;

  if (!isNonEmptyString(raw.domain)) {
    fail(worldLabel, `"domain" must be a non-empty string.`);
  }
  const decision = validateDecision(raw.decision, worldLabel);
  const memory = validateMemory(raw.memory, worldLabel);

  if (!Array.isArray(raw.probes) || raw.probes.length === 0) {
    fail(worldLabel, `"probes" must be a non-empty array — a world with no probes tests nothing.`);
  }
  const probes = raw.probes.map((p: unknown, i: number) => validateProbe(p, worldLabel, i));

  const hasPerturbation = probes.some((p) => p.kind === "perturbation");
  const hasStasis = probes.some((p) => p.kind === "stasis");
  if (!hasPerturbation) {
    fail(worldLabel, `"probes" must include at least one "perturbation" probe.`);
  }
  if (!hasStasis) {
    fail(worldLabel, `"probes" must include at least one "stasis" probe (a control against always-flip agents).`);
  }

  return { id: raw.id, domain: raw.domain, decision, memory, probes };
}

/**
 * Validate a parsed corpus payload (already-JSON.parse'd) into an array of
 * `World`s. Throws with a message naming the offending world's index/id and
 * field on the first structural problem found.
 */
export function validateCorpus(data: unknown): World[] {
  if (!Array.isArray(data)) {
    throw new Error(
      `Evolvability corpus: top-level value must be an array of World objects ` +
        `(got ${isPlainObject(data) ? "object" : typeof data}).`,
    );
  }
  if (data.length === 0) {
    throw new Error(`Evolvability corpus: must contain at least one World.`);
  }

  const worlds = data.map((raw, i) => validateWorld(raw, i));

  const seen = new Map<string, number>();
  for (const [i, w] of worlds.entries()) {
    const firstIndex = seen.get(w.id);
    if (firstIndex !== undefined) {
      throw new Error(
        `Evolvability corpus: duplicate world id "${w.id}" at indices ${firstIndex} and ${i} — ` +
          `world ids must be unique.`,
      );
    }
    seen.set(w.id, i);
  }

  return worlds;
}

/**
 * Load a corpus JSON file from disk, parse it, and validate it into `World`s.
 * Returns the loaded worlds alongside the source path and a SHA-256 of the
 * raw file bytes (for lineage/reproducibility, mirroring the ci-gate pattern).
 */
export function loadCorpus(path: string): CorpusLoadResult {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw new Error(
      `Evolvability corpus: could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf-8"));
  } catch (err) {
    throw new Error(
      `Evolvability corpus: ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const worlds = validateCorpus(parsed);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { worlds, path, sha256 };
}
