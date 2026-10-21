import type { PairOutcome } from "./types.js";
/** Paired percentile bootstrap; development evidence, fixed seed and exactly 2000 resamples. */
export function summarizePairs(rows: PairOutcome[]) {
  if (new Set(rows.map((row) => row.query_id)).size !== rows.length) throw new Error("Duplicate paired query ID");
  const paired = rows.filter((row) => row.baseline !== null && row.core !== null);
  const deltas = paired.map((row) => Number(row.core!.correct) - Number(row.baseline!.correct));
  let state = 227;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const samples = deltas.length === 0 ? [] : Array.from({ length: 2000 }, () => {
    let sum = 0; for (let i = 0; i < deltas.length; i++) sum += deltas[Math.floor(random() * deltas.length)]; return sum / deltas.length;
  }).sort((a, b) => a - b);
  const accuracy = (variant: "baseline" | "core") => paired.length ? paired.filter((row) => row[variant]!.correct).length / paired.length : null;
  const categories = [...new Set(rows.map((row) => row.category))].sort().map((category) => {
    const selected = paired.filter((row) => row.category === category);
    const correct = (variant: "baseline" | "core") => selected.filter((row) => row[variant]!.correct).length;
    return { category, query_count: rows.filter((row) => row.category === category).length, complete_pairs: selected.length,
      baseline_accuracy: selected.length ? correct("baseline") / selected.length : null, core_accuracy: selected.length ? correct("core") / selected.length : null,
      accuracy_delta: selected.length ? (correct("core") - correct("baseline")) / selected.length : null,
      gained_question_ids: selected.filter((row) => !row.baseline!.correct && row.core!.correct).map((row) => row.query_id),
      lost_question_ids: selected.filter((row) => row.baseline!.correct && !row.core!.correct).map((row) => row.query_id) };
  });
  return { query_count: rows.length, complete_pairs: paired.length, incomplete_pairs: rows.length - paired.length,
    baseline_accuracy: accuracy("baseline"), core_accuracy: accuracy("core"), accuracy_delta: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null,
    gained_question_ids: paired.filter((row) => !row.baseline!.correct && row.core!.correct).map((row) => row.query_id),
    lost_question_ids: paired.filter((row) => row.baseline!.correct && !row.core!.correct).map((row) => row.query_id),
    abstentions: { baseline: rows.filter((row) => row.baseline?.abstained).length, core: rows.filter((row) => row.core?.abstained).length },
    by_category: categories,
    bootstrap: { seed: 227, resamples: 2000, confidence: 0.95, method: "paired_percentile" as const, lower: samples.length ? samples[49] : null, upper: samples.length ? samples[1949] : null },
  };
}
