import { describe, it, expect } from "vitest";
import { compareHybridResults } from "../src/internal/retrieval-shared.js";

interface Row {
  entry: { id: string };
  score: number;
  lexicalRank?: number;
  semanticRank?: number;
}

const K = 60;
function row(id: string, lexicalRank?: number, semanticRank?: number): Row {
  return {
    entry: { id },
    score: (lexicalRank !== undefined ? 1 / (K + lexicalRank) : 0) + (semanticRank !== undefined ? 1 / (K + semanticRank) : 0),
    lexicalRank,
    semanticRank,
  };
}
const order = (rows: Row[]) => [...rows].sort(compareHybridResults).map((r) => r.entry.id);

describe("compareHybridResults (#340)", () => {
  it("orders equal scores lexical-only before semantic-only regardless of id", () => {
    // Same rank in different legs gives equal scores; ids deliberately invert.
    expect(order([row("a-sem", undefined, 1), row("z-lex", 1, undefined)])).toEqual(["z-lex", "a-sem"]);
  });

  it("orders ties by lexical rank ascending, then semantic-only by semantic rank", () => {
    const rows = [row("s2", undefined, 2), row("l2", 2), row("s1", undefined, 1), row("l1", 1)];
    expect(order(rows)).toEqual(["l1", "s1", "l2", "s2"]);
  });

  it("ranks an entry without a lexical rank after any entry with one on equal scores", () => {
    const a = row("both", 1, 3);
    const b = { ...row("lex-only", 1), score: a.score };
    expect(order([a, b])).toEqual(["both", "lex-only"]);
    // both entries have lexical rank 1; semantic rank decides: present beats missing.
    expect(order([b, a])).toEqual(["both", "lex-only"]);
  });

  it("uses semantic rank when lexical ranks are equal or absent on both", () => {
    const x = { ...row("x", 5, 2), score: 1 };
    const y = { ...row("y", 5, 1), score: 1 };
    expect(order([x, y])).toEqual(["y", "x"]);
  });

  it("falls through to entry id when ranks are equal", () => {
    const x = { ...row("b", 3, 4), score: 1 };
    const y = { ...row("a", 3, 4), score: 1 };
    expect(order([x, y])).toEqual(["a", "b"]);
  });

  it("score still dominates ranks", () => {
    expect(order([row("low", undefined, 9), row("high", 2, 2)])).toEqual(["high", "low"]);
  });

  it("yields one order for any permutation of the input", () => {
    const base = [
      row("m", 1), row("a", undefined, 1), row("q", 2, 5), row("c", undefined, 2),
      row("b", 2), row("z", 3, undefined), row("d", undefined, 3), row("e", 5, 5),
    ];
    const expected = order(base);
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 50; n++) {
      const shuffled = [...base];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(order(shuffled)).toEqual(expected);
    }
  });
});
