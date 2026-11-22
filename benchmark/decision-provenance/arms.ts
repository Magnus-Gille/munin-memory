/**
 * Builds the memory payload string an agent under test is given, per
 * experiment arm.
 *
 *   - Arm A (destination only) — the compressed "what was chosen" entry,
 *     with no rationale or rejected-alternative detail.
 *   - Arm B (destination + path) — the destination entry plus every
 *     path_log entry (rationale + rejected alternatives), verbatim.
 *   - Arm C (destination + neutral filler) — the destination entry plus a
 *     deterministically constructed filler block, built from OTHER worlds'
 *     path_logs, with this world's distinctive rationale/rejected tokens
 *     stripped, length-matched to arm B's path payload within ±10%. This is
 *     the active control: it separates "more context mass" from "the
 *     specific path information" as the explanation for any behavior delta
 *     between arm A and arm B.
 *
 * Deterministic and non-LLM by design — the filler must be reproducible
 * across runs and machines, and must never require a model call to build.
 */

import type { World, PathLogEntry, DestinationEntry, Arm } from "./types.js";

// --- Formatting ---

function formatDestinationEntry(entry: DestinationEntry): string {
  return `[MEMORY namespace=${entry.namespace} key=${entry.key} tags=${entry.tags.join(",")}]\n${entry.content}`;
}

function formatPathLogEntry(entry: PathLogEntry): string {
  return `[LOG namespace=${entry.namespace} ts=${entry.ts} tags=${entry.tags.join(",")}]\n${entry.content}`;
}

/** The destination-only block shared by all three arms. */
function destinationBlock(world: World): string {
  return formatDestinationEntry(world.memory.destination);
}

/**
 * The "path payload" of a world: every path_log entry, formatted and joined,
 * with none of the destination content. This is the quantity arm C's filler
 * is length-matched against.
 */
export function armBPathPayload(world: World): string {
  return world.memory.path_logs.map(formatPathLogEntry).join("\n\n");
}

// --- Distinctive-token extraction (for arm C leakage prevention) ---

/** Words shorter than this or in the stopword list are never treated as distinctive. */
const MIN_TOKEN_LENGTH = 4;

const STOPWORDS: ReadonlySet<string> = new Set([
  "that",
  "this",
  "with",
  "from",
  "have",
  "were",
  "because",
  "chosen",
  "solely",
  "reason",
  "rejected",
  "option",
  "decision",
  "would",
  "which",
  "there",
  "their",
  "about",
  "into",
  "only",
  "than",
  "then",
]);

/**
 * Collect the distinctive words + full option phrases from a world's
 * rationale and rejected-alternative text. Used to redact overlap out of
 * arm C's filler so it never leaks this world's specific path information.
 *
 * Returns lowercase tokens: individual words (length >= MIN_TOKEN_LENGTH,
 * minus common stopwords) plus each rejected option's full phrase (so
 * multi-word product/vendor names are stripped as a unit, not just their
 * individual words).
 */
export function extractDistinctiveTokens(world: World): string[] {
  const text = [
    world.decision.rationale,
    ...world.decision.rejected.flatMap((r) => [r.option, r.reason]),
  ].join(" ");

  const words = text.match(/[A-Za-z][A-Za-z0-9'-]*/g) ?? [];
  const tokens = new Set<string>();
  for (const w of words) {
    const lower = w.toLowerCase();
    if (lower.length < MIN_TOKEN_LENGTH || STOPWORDS.has(lower)) continue;
    tokens.add(lower);
  }
  for (const r of world.decision.rejected) {
    const phrase = r.option.trim().toLowerCase();
    if (phrase.length > 0) tokens.add(phrase);
  }
  return [...tokens];
}

/**
 * Replace every occurrence of every token (case-insensitive, substring match)
 * with a neutral placeholder. Longest tokens are replaced first so multi-word
 * phrases are consumed before their individual words would otherwise match.
 */
function redactTokens(text: string, tokens: string[]): string {
  if (tokens.length === 0) return text;
  let out = text;
  const sorted = [...tokens].sort((a, b) => b.length - a.length);
  for (const token of sorted) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), "GENERIC");
  }
  return out;
}

// --- Filler construction (arm C) ---

const NEUTRAL_FILLER_SENTENCE =
  "This is a neutral filler sentence with no bearing on any tracked decision. ";

/** Cycle-repeat `source` until it reaches at least `targetLength` characters, then trim to it. */
function fitToLength(source: string, targetLength: number): string {
  if (targetLength <= 0) return "";
  const base = source.length > 0 ? source : NEUTRAL_FILLER_SENTENCE;
  let out = "";
  // Safety valve against pathological inputs (e.g. a single-character base):
  // cap iterations rather than looping until length is hit no matter what.
  let guard = 0;
  while (out.length < targetLength && guard < 10_000) {
    out += (out.length > 0 ? "\n\n" : "") + base;
    guard++;
  }
  return out.slice(0, targetLength);
}

/**
 * Build the arm-C filler payload for `world`, drawn from every OTHER world's
 * path_logs in `corpus`, with `world`'s distinctive rationale/rejected tokens
 * redacted, and length-matched to `targetLength` (arm B's path payload
 * length) by cycling/trimming.
 *
 * When the corpus has no other worlds (degenerate single-world case), falls
 * back to a fixed neutral sentence — still guaranteed to contain none of
 * `world`'s tokens, and still length-matched.
 */
export function buildFillerPayload(world: World, corpus: World[], targetLength: number): string {
  const others = corpus.filter((w) => w.id !== world.id);
  const tokens = extractDistinctiveTokens(world);

  if (others.length === 0) {
    return fitToLength(redactTokens(NEUTRAL_FILLER_SENTENCE, tokens), targetLength);
  }

  const sourceBlocks = others.flatMap((w) =>
    w.memory.path_logs.map((log) =>
      formatPathLogEntry({ ...log, namespace: `filler/${w.id}` }),
    ),
  );
  const redacted = redactTokens(sourceBlocks.join("\n\n"), tokens);
  return fitToLength(redacted, targetLength);
}

// --- Arm payload assembly ---

/**
 * Build the full memory payload string for `world` under the given `arm`.
 * `corpus` is the full loaded corpus (used only by arm C to source filler
 * material from other worlds); passing `[world]` alone degrades arm C to its
 * neutral-sentence fallback.
 */
export function buildArmPayload(world: World, arm: Arm, corpus: World[]): string {
  const destination = destinationBlock(world);

  if (arm === "A") {
    return destination;
  }

  if (arm === "B") {
    const path = armBPathPayload(world);
    return path.length > 0 ? `${destination}\n\n${path}` : destination;
  }

  // arm === "C"
  const targetLength = armBPathPayload(world).length;
  const filler = buildFillerPayload(world, corpus, targetLength);
  return filler.length > 0 ? `${destination}\n\n${filler}` : destination;
}
