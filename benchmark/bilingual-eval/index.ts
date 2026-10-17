/** Offline contracts and scoring only. This module never loads a model or writes memory. */
import { createHash } from "node:crypto";

export const DIRECTIONS = ["sv-sv", "en-en", "sv-en", "en-sv"] as const;
export const MODES = ["lexical", "semantic", "raw_hybrid", "production_hybrid"] as const;
type Direction = typeof DIRECTIONS[number];
type Mode = typeof MODES[number];
type Span = { entry_id: string; start: number; end: number };
type Hashes = { corpus: string; queries: string; labels: string; evidence: string; dataset: string };
export interface Fixture {
  schema_version: 1;
  kind: "bilingual_retrieval_fixture";
  id: string;
  source: "synthetic" | "public" | "approved_private";
  review: { status: "candidate" | "human_reviewed"; reviewer: string | null };
  held_out: boolean;
  fixed_clock: string;
  token_budget: number;
  top_k: number;
  thresholds: {
    status: "preregistered_for_review";
    recall_delta_min: number; mrr_delta_min: number;
    complete_evidence_delta_min: number; hard_negative_rate_max: number;
    bootstrap: { seed: number; resamples: number };
  };
  corpus: Array<{ id: string; text: string; language: "sv" | "en" }>;
  cases: Array<{
    id: string; direction: Direction; category: "decision" | "status" | "preference";
    query: string;
    labels: { relevant_ids: string[]; hard_negative_ids: string[]; evidence: Span[] };
  }>;
  hashes: Hashes;
}
export interface EmbeddingIdentity {
  model: string; revision: string; dtype: string; dimensions: number;
  pooling: string; normalize: boolean; instructions: string; truncation: string;
  runtime: { transformers: string; onnx: string; device: string };
}
export interface RecordedRun {
  schema_version: 1;
  kind: "recorded_bilingual_retrieval";
  acquisition: "stub" | "recorded_live";
  mode: Mode;
  hashes: Hashes;
  fixed_clock: string;
  token_budget: number;
  top_k: number;
  embedding: EmbeddingIdentity;
  fusion: { revision: string; k: number };
  ranker_revision: string;
  results: Array<{
    case_id: string;
    ranked_ids: string[];
    retained: Array<Span & { text: string }>;
  }>;
}
type ObjectValue = Record<string, unknown>;
function fail(message: string): never { throw new Error(message); }
function object(value: unknown, keys: string[], where: string): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${where}: expected object`);
  const result = value as ObjectValue;
  if (Object.keys(result).some(key => !keys.includes(key))) fail(`${where}: unknown field`);
  if (keys.some(key => !Object.hasOwn(result, key))) fail(`${where}: missing field`);
  return result;
}
function string(value: unknown, where: string, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) fail(`${where}: expected string`);
}
function number(value: unknown, where: string, min: number, max: number, integer = false): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) fail(`${where}: invalid number`);
}
function boolean(value: unknown, where: string): void {
  if (typeof value !== "boolean") fail(`${where}: expected boolean`);
}
function choice(value: unknown, allowed: readonly unknown[], where: string): void {
  if (!allowed.includes(value)) fail(`${where}: unsupported value`);
}
function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where}: expected array`);
  return value;
}
function ids(value: unknown, where: string, nonempty = true): string[] {
  const values = array(value, where);
  values.forEach(item => string(item, where));
  if ((nonempty && !values.length) || new Set(values).size !== values.length) fail(`${where}: empty or duplicate IDs`);
  return values as string[];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function runProvenance(run: RecordedRun): Omit<RecordedRun, "results"> {
  const { results, ...provenance } = run;
  void results;
  return provenance;
}
function hashes(value: unknown): void {
  const result = object(value, ["corpus", "queries", "labels", "evidence", "dataset"], "hashes");
  for (const item of Object.values(result)) if (typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item)) fail("hashes: expected SHA-256");
}
/** Hash domains are specified in README.md; hashes never authenticate a reviewer. */
export function sealFixture(value: Omit<Fixture, "hashes"> | Fixture): Fixture {
  const { hashes: _ignored, ...body } = value as Fixture;
  void _ignored;
  const bindings = {
    corpus: hash(body.corpus),
    queries: hash(body.cases.map(({ id, query, direction, category }) => ({ id, query, direction, category }))),
    labels: hash(body.cases.map(({ id, labels }) => ({ id, relevant_ids: labels.relevant_ids, hard_negative_ids: labels.hard_negative_ids }))),
    evidence: hash(body.cases.map(({ id, labels }) => ({ id, evidence: labels.evidence }))),
  };
  return { ...body, hashes: { ...bindings, dataset: hash({ ...body, hashes: bindings }) } };
}
function clock(value: unknown): void {
  string(value, "fixed_clock");
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail("fixed_clock: expected canonical UTC timestamp");
}
function span(value: unknown, corpus: Map<string, Fixture["corpus"][number]>, retained: boolean): Span & { text?: string } {
  const result = object(value, retained ? ["entry_id", "start", "end", "text"] : ["entry_id", "start", "end"], "span");
  string(result.entry_id, "span entry_id");
  const entry = corpus.get(result.entry_id);
  if (!entry) fail("span: unknown corpus entry");
  number(result.start, "span start", 0, entry.text.length, true);
  number(result.end, "span end", result.start + 1, entry.text.length, true);
  // UTF-16 source offsets must not split a supplementary Unicode character.
  for (const position of [result.start, result.end]) {
    if (position > 0 && position < entry.text.length && /[\uD800-\uDBFF]/.test(entry.text[position - 1]) && /[\uDC00-\uDFFF]/.test(entry.text[position])) fail("span: split Unicode character");
  }
  if (retained && result.text !== entry.text.slice(result.start, result.end)) fail("retained span does not match source text");
  return result as Span & { text?: string };
}
export function parseFixture(value: unknown): Fixture {
  const data = object(value, ["schema_version", "kind", "id", "source", "review", "held_out", "fixed_clock", "token_budget", "top_k", "thresholds", "corpus", "cases", "hashes"], "fixture");
  choice(data.schema_version, [1], "schema_version");
  choice(data.kind, ["bilingual_retrieval_fixture"], "kind");
  string(data.id, "fixture id"); choice(data.source, ["synthetic", "public", "approved_private"], "source");
  const review = object(data.review, ["status", "reviewer"], "review");
  choice(review.status, ["candidate", "human_reviewed"], "review status");
  if (review.status === "human_reviewed") string(review.reviewer, "review reviewer");
  else if (review.reviewer !== null) fail("candidate review must have null reviewer");
  boolean(data.held_out, "held_out"); clock(data.fixed_clock);
  number(data.token_budget, "token_budget", 1, 1000000, true); number(data.top_k, "top_k", 1, 1000, true);
  const thresholds = object(data.thresholds, ["status", "recall_delta_min", "mrr_delta_min", "complete_evidence_delta_min", "hard_negative_rate_max", "bootstrap"], "thresholds");
  choice(thresholds.status, ["preregistered_for_review"], "threshold status");
  for (const key of ["recall_delta_min", "mrr_delta_min", "complete_evidence_delta_min"]) number(thresholds[key], key, -1, 1);
  number(thresholds.hard_negative_rate_max, "hard_negative_rate_max", 0, 1);
  const bootstrap = object(thresholds.bootstrap, ["seed", "resamples"], "bootstrap");
  number(bootstrap.seed, "seed", 0, 0xffffffff, true); number(bootstrap.resamples, "resamples", 100, 10000, true);
  const entries = array(data.corpus, "corpus").map(item => {
    const entry = object(item, ["id", "text", "language"], "corpus entry");
    string(entry.id, "entry id"); string(entry.text, "entry text"); choice(entry.language, ["sv", "en"], "language");
    return entry as Fixture["corpus"][number];
  });
  const corpus = new Map(entries.map(item => [item.id, item]));
  if (!entries.length || corpus.size !== entries.length) fail("corpus: empty or duplicate IDs");
  const seen = new Set<string>();
  const directions = new Map<string, number>();
  for (const item of array(data.cases, "cases")) {
    const record = object(item, ["id", "direction", "category", "query", "labels"], "case");
    string(record.id, "case id"); string(record.query, "case query");
    if (seen.has(record.id)) fail("duplicate case ID"); seen.add(record.id);
    choice(record.direction, DIRECTIONS, "case direction"); choice(record.category, ["decision", "status", "preference"], "category");
    const direction = record.direction as Direction;
    directions.set(direction, (directions.get(direction) ?? 0) + 1);
    const labels = object(record.labels, ["relevant_ids", "hard_negative_ids", "evidence"], "labels");
    const relevant = ids(labels.relevant_ids, "relevant labels"); const negatives = ids(labels.hard_negative_ids, "negative labels");
    for (const id of [...relevant, ...negatives]) if (!corpus.has(id)) fail("label references unknown corpus ID");
    if (negatives.some(id => relevant.includes(id))) fail("positive and negative labels overlap");
    if (relevant.some(id => corpus.get(id)!.language !== direction.split("-")[1])) fail("direction does not match evidence language");
    const evidence = array(labels.evidence, "evidence").map(item => span(item, corpus, false));
    if (evidence.some(item => !relevant.includes(item.entry_id)) || relevant.some(id => !evidence.some(item => item.entry_id === id))) fail("evidence must cover every relevant label and no other entry");
  }
  if (DIRECTIONS.some(direction => (directions.get(direction) ?? 0) < 4)) fail("each language direction requires at least four cases");
  hashes(data.hashes);
  const result = data as unknown as Fixture;
  if (canonical(result.hashes) !== canonical(sealFixture(result).hashes)) fail("fixture hash mismatch");
  return structuredClone(result);
}
function identity(value: unknown): void {
  const data = object(value, ["model", "revision", "dtype", "dimensions", "pooling", "normalize", "instructions", "truncation", "runtime"], "embedding identity");
  for (const key of ["model", "revision", "dtype", "pooling", "truncation"]) string(data[key], key);
  string(data.instructions, "instructions", true); boolean(data.normalize, "normalize"); number(data.dimensions, "dimensions", 1, 65536, true);
  const runtime = object(data.runtime, ["transformers", "onnx", "device"], "runtime");
  Object.values(runtime).forEach(item => string(item, "runtime identity"));
}
export function parseRun(value: unknown, fixture: Fixture): RecordedRun {
  const data = object(value, ["schema_version", "kind", "acquisition", "mode", "hashes", "fixed_clock", "token_budget", "top_k", "embedding", "fusion", "ranker_revision", "results"], "recorded run");
  choice(data.schema_version, [1], "schema_version"); choice(data.kind, ["recorded_bilingual_retrieval"], "kind");
  choice(data.acquisition, ["stub", "recorded_live"], "acquisition"); choice(data.mode, MODES, "mode");
  hashes(data.hashes); clock(data.fixed_clock); identity(data.embedding); string(data.ranker_revision, "ranker_revision");
  const fusion = object(data.fusion, ["revision", "k"], "fusion"); string(fusion.revision, "fusion revision"); number(fusion.k, "fusion k", 1, 1000000, true);
  if (canonical(data.hashes) !== canonical(fixture.hashes) || data.fixed_clock !== fixture.fixed_clock || data.token_budget !== fixture.token_budget || data.top_k !== fixture.top_k) fail("run binding differs from fixture");
  const corpus = new Map(fixture.corpus.map(item => [item.id, item]));
  const expected = new Set(fixture.cases.map(item => item.id)); const seen = new Set<string>();
  for (const item of array(data.results, "results")) {
    const result = object(item, ["case_id", "ranked_ids", "retained"], "result"); string(result.case_id, "case_id");
    if (!expected.has(result.case_id) || seen.has(result.case_id)) fail("unknown or duplicate result case ID"); seen.add(result.case_id);
    const ranked = ids(result.ranked_ids, "ranked case IDs", false);
    if (ranked.some(id => !corpus.has(id))) fail("ranked case references unknown corpus ID");
    const retained = array(result.retained, "retained").map(item => span(item, corpus, true));
    if (retained.some(item => !ranked.slice(0, fixture.top_k).includes(item.entry_id))) fail("retained span outside ranked top-k");
    const text = retained.map(item => item.text).join("\n\n");
    if (Math.ceil(Buffer.byteLength(text, "utf8") / 4) > fixture.token_budget) fail("retained text exceeds token budget");
  }
  if (seen.size !== expected.size) fail("missing result cases");
  return structuredClone(data as unknown as RecordedRun);
}
type Metrics = { recall: number; mrr: number; hard_negative_rate: number; complete_evidence: number };
const METRICS: Array<keyof Metrics> = ["recall", "mrr", "hard_negative_rate", "complete_evidence"];
function caseMetrics(record: RecordedRun["results"][number], item: Fixture["cases"][number], topK: number): Metrics {
  const ranked = record.ranked_ids.slice(0, topK); const labels = item.labels;
  const first = ranked.findIndex(id => labels.relevant_ids.includes(id));
  return {
    recall: labels.relevant_ids.filter(id => ranked.includes(id)).length / labels.relevant_ids.length,
    mrr: first < 0 ? 0 : 1 / (first + 1),
    hard_negative_rate: labels.hard_negative_ids.some(id => ranked.includes(id)) ? 1 : 0,
    complete_evidence: labels.evidence.every(evidence => record.retained.some(retained => retained.entry_id === evidence.entry_id && retained.start <= evidence.start && retained.end >= evidence.end)) ? 1 : 0,
  };
}
function average(values: Metrics[]): Metrics {
  return Object.fromEntries(METRICS.map(key => [key, values.reduce((sum, value) => sum + value[key], 0) / values.length])) as Metrics;
}
function pairedInterval(values: number[], seed: number, resamples: number) {
  let state = seed;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const samples: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let total = 0;
    for (let j = 0; j < values.length; j++) total += values[Math.floor(random() * values.length)];
    samples.push(total / values.length);
  }
  samples.sort((a, b) => a - b);
  return { point: values.reduce((sum, item) => sum + item, 0) / values.length, lower: samples[Math.floor(0.025 * (resamples - 1))], upper: samples[Math.ceil(0.975 * (resamples - 1))], confidence: 0.95, seed, resamples };
}
export function compareRuns(rawFixture: unknown, rawBaseline: unknown, rawCandidate: unknown, axis: "repeat" | "embedding" | "fusion") {
  const fixture = parseFixture(rawFixture); const baseline = parseRun(rawBaseline, fixture); const candidate = parseRun(rawCandidate, fixture);
  choice(axis, ["repeat", "embedding", "fusion"], "comparison axis");
  if (baseline.mode !== candidate.mode || baseline.ranker_revision !== candidate.ranker_revision
    || (axis !== "embedding" && canonical(baseline.embedding) !== canonical(candidate.embedding))
    || (axis !== "fusion" && canonical(baseline.fusion) !== canonical(candidate.fusion))
    || (axis === "fusion" && !["raw_hybrid", "production_hybrid"].includes(baseline.mode))) fail("incomparable runs: change exactly the declared axis under fixed bindings");
  const before = new Map(baseline.results.map(item => [item.case_id, item]));
  const after = new Map(candidate.results.map(item => [item.case_id, item]));
  const cases = fixture.cases.map(item => ({ id: item.id, direction: item.direction,
    baseline: caseMetrics(before.get(item.id)!, item, fixture.top_k), candidate: caseMetrics(after.get(item.id)!, item, fixture.top_k) }));
  const groups = ["overall", ...DIRECTIONS] as const;
  const aggregate = (side: "baseline" | "candidate") => Object.fromEntries(groups.map(group => [group, average(cases.filter(item => group === "overall" || item.direction === group).map(item => item[side]))])) as Record<typeof groups[number], Metrics>;
  const uncertainty = Object.fromEntries(groups.map(group => {
    const subset = cases.filter(item => group === "overall" || item.direction === group);
    return [group, Object.fromEntries(METRICS.map(metric => [metric, pairedInterval(subset.map(item => item.candidate[metric] - item.baseline[metric]), fixture.thresholds.bootstrap.seed, fixture.thresholds.bootstrap.resamples)]))];
  })) as Record<typeof groups[number], Record<keyof Metrics, ReturnType<typeof pairedInterval>>>;
  return {
    schema_version: 1, status: "incomplete", publication_eligible: false,
    evidence_kind: "offline_foundation_only", axis, mode: baseline.mode, hashes: fixture.hashes,
    fixed_clock: fixture.fixed_clock, top_k: fixture.top_k, token_budget: fixture.token_budget,
    baseline: {
      metrics: aggregate("baseline"),
      provenance: runProvenance(baseline),
      digest: hash(baseline),
    },
    candidate: {
      metrics: aggregate("candidate"),
      provenance: runProvenance(candidate),
      digest: hash(candidate),
    },
    uncertainty,
    gained: cases.filter(item => item.candidate.recall > item.baseline.recall).map(item => item.id),
    lost: cases.filter(item => item.candidate.recall < item.baseline.recall).map(item => item.id),
    per_case: cases, thresholds: fixture.thresholds,
    pending: [
      ...(fixture.review.status !== "human_reviewed" ? ["human_review"] : []),
      ...(!fixture.held_out ? ["held_out_bank"] : []),
      ...(baseline.acquisition !== "recorded_live" || candidate.acquisition !== "recorded_live" ? ["live_model_runs"] : []),
      "hardware_measurements", "threshold_review", "release_and_rollback_decision",
    ],
  };
}
/** Fabricated perfect rankings for plumbing tests, never model/quality evidence. */
export function makeSmokeRun(fixture: Fixture, mode: Mode): RecordedRun {
  const corpus = new Map(fixture.corpus.map(item => [item.id, item]));
  return {
    schema_version: 1, kind: "recorded_bilingual_retrieval", acquisition: "stub", mode,
    hashes: structuredClone(fixture.hashes), fixed_clock: fixture.fixed_clock, token_budget: fixture.token_budget, top_k: fixture.top_k,
    embedding: { model: "synthetic-stub", revision: "stub-v1", dtype: "stub-fp32", dimensions: 384, pooling: "mean", normalize: true, instructions: "", truncation: "none", runtime: { transformers: "not-run", onnx: "not-run", device: "not-run" } },
    fusion: { revision: "stub-rrf-v1", k: 60 }, ranker_revision: mode === "production_hybrid" ? "stub-production-v1" : "not-applied",
    results: fixture.cases.map(item => ({ case_id: item.id, ranked_ids: [...item.labels.relevant_ids], retained: item.labels.evidence.map(evidence => ({ ...evidence, text: corpus.get(evidence.entry_id)!.text.slice(evidence.start, evidence.end) })) })),
  };
}
