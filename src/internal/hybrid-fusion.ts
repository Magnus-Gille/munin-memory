import type { Entry } from "../types.js";
import type { LexicalQueryResult, SemanticQueryResult, HybridQueryResult } from "../db.js";
import { compareHybridResults } from "./retrieval-shared.js";

// Shared fusion of already-bounded retrieval legs for production and benchmarks.
export function fuseHybridResults(
  ftsResults: LexicalQueryResult[],
  semanticResults: SemanticQueryResult[],
): HybridQueryResult[] {
  const lexicalById = new Map(ftsResults.map((result) => [result.entry.id, result] as const));
  const semanticById = new Map(semanticResults.map((result) => [result.entry.id, result] as const));
  const entryMap = new Map<string, Entry>();
  for (const result of ftsResults) entryMap.set(result.entry.id, result.entry);
  for (const result of semanticResults) entryMap.set(result.entry.id, result.entry);

  const allIds = new Set<string>([...lexicalById.keys(), ...semanticById.keys()]);
  const k = 60;
  const scored: HybridQueryResult[] = [];

  for (const id of allIds) {
    const lexical = lexicalById.get(id);
    const semantic = semanticById.get(id);
    let score = 0;
    if (lexical) score += 1 / (k + lexical.rank);
    if (semantic) score += 1 / (k + semantic.rank);
    scored.push({
      entry: entryMap.get(id)!,
      score,
      lexicalRank: lexical?.rank,
      lexicalScore: lexical?.score,
      semanticRank: semantic?.rank,
      semanticDistance: semantic?.distance,
    });
  }

  scored.sort(compareHybridResults);
  return scored;
}
