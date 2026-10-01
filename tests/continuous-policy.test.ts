import { describe, expect, it } from "vitest";
import { withEvaluationClock } from "../benchmark/continuous/clock.js";
import { compareMetrics } from "../benchmark/continuous/policy.js";

describe("withEvaluationClock", () => {
  it("keeps Date frozen across an await and preserves explicit Date behavior", async () => {
    const nativeDate = globalThis.Date;
    const nativeNow = Date.now;
    const anchor = "2026-02-01T12:34:56.789Z";
    const anchorMs = nativeDate.parse(anchor);
    const explicitInput = "2001-02-03T04:05:06.000Z";
    const explicitMs = nativeDate.parse(explicitInput);
    const expectedUtc = nativeDate.UTC(2020, 0, 2, 3, 4, 5);

    await withEvaluationClock(anchor, async () => {
      expect(globalThis.Date).not.toBe(nativeDate);
      expect(Date.now()).toBe(anchorMs);
      expect(new Date().getTime()).toBe(anchorMs);

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(Date.now()).toBe(anchorMs);
      expect(new Date().toISOString()).toBe(anchor);
      expect(new Date(explicitInput).getTime()).toBe(explicitMs);
      expect(Date.parse(explicitInput)).toBe(explicitMs);
      expect(Date.UTC(2020, 0, 2, 3, 4, 5)).toBe(expectedUtc);
    });

    expect(globalThis.Date).toBe(nativeDate);
    expect(Date.now).toBe(nativeNow);
  });

  it("restores the native Date after the callback rejects", async () => {
    const nativeDate = globalThis.Date;
    const nativeNow = Date.now;
    const failure = new Error("evaluation failed");

    await expect(withEvaluationClock("2026-02-01T00:00:00.000Z", async () => {
      await Promise.resolve();
      throw failure;
    })).rejects.toBe(failure);

    expect(globalThis.Date).toBe(nativeDate);
    expect(Date.now).toBe(nativeNow);
  });

  it("rejects nested use without replacing or restoring the active clock", async () => {
    const nativeDate = globalThis.Date;
    const anchor = "2026-02-01T00:00:00.000Z";
    const anchorMs = nativeDate.parse(anchor);

    await withEvaluationClock(anchor, async () => {
      const activeDate = globalThis.Date;
      await expect(withEvaluationClock("2026-03-01T00:00:00.000Z", async () => undefined))
        .rejects.toThrow(/already active/);
      expect(globalThis.Date).toBe(activeDate);
      expect(Date.now()).toBe(anchorMs);
    });

    expect(globalThis.Date).toBe(nativeDate);
  });

  it("rejects concurrent use without disturbing the first caller's clock", async () => {
    const nativeDate = globalThis.Date;
    const anchor = "2026-02-01T00:00:00.000Z";
    const anchorMs = nativeDate.parse(anchor);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const first = withEvaluationClock(anchor, async () => {
      entered();
      await blocked;
      expect(Date.now()).toBe(anchorMs);
    });
    await started;
    const activeDate = globalThis.Date;

    await expect(withEvaluationClock("2026-03-01T00:00:00.000Z", async () => undefined))
      .rejects.toThrow(/already active/);
    expect(globalThis.Date).toBe(activeDate);
    expect(Date.now()).toBe(anchorMs);

    release();
    await first;
    expect(globalThis.Date).toBe(nativeDate);
  });

  it("rejects invalid timestamps before changing Date or invoking the callback", async () => {
    const nativeDate = globalThis.Date;
    const nativeNow = Date.now;
    let called = false;

    await expect(withEvaluationClock("not-a-timestamp", async () => { called = true; }))
      .rejects.toThrow(/valid date string/);

    expect(called).toBe(false);
    expect(globalThis.Date).toBe(nativeDate);
    expect(Date.now).toBe(nativeNow);
  });
});

describe("compareMetrics", () => {
  it("reports ordered improvements and regressions, with regression taking precedence", () => {
    const result = compareMetrics(
      { recallAt1: 0.7, mrr: 0.9, recallAt5: 0.9 },
      { recallAt5: 0.8, mrr: 0.8, recallAt1: 0.8 },
    );

    expect(result).toEqual({
      status: "regressed",
      regressions: [{ metric: "recallAt1", current: 0.7, baseline: 0.8 }],
      improvements: [
        { metric: "mrr", current: 0.9, baseline: 0.8 },
        { metric: "recallAt5", current: 0.9, baseline: 0.8 },
      ],
    });
  });

  it("reports improvement or unchanged within the configured tolerance", () => {
    expect(compareMetrics({ mrr: 0.81 }, { mrr: 0.8 }).status).toBe("improved");
    expect(compareMetrics({ mrr: 0.8 + 5e-10 }, { mrr: 0.8 }, 1e-9)).toEqual({
      status: "unchanged",
      regressions: [],
      improvements: [],
    });
    expect(compareMetrics({ mrr: 0.8 - 2e-9 }, { mrr: 0.8 }, 1e-9).status).toBe("regressed");
  });

  it("requires non-empty records with exactly matching keys", () => {
    expect(() => compareMetrics({}, {})).toThrow(/at least one metric/);
    expect(() => compareMetrics({ recall: 1 }, {})).toThrow(/at least one metric/);
    expect(() => compareMetrics({ recall: 1, mrr: 1 }, { recall: 1 })).toThrow(/same metric keys/);
  });

  it("rejects non-finite and out-of-range scores", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01, 1.01]) {
      expect(() => compareMetrics({ recall: value }, { recall: 0.5 })).toThrow(/finite numbers in \[0, 1\]/);
      expect(() => compareMetrics({ recall: 0.5 }, { recall: value })).toThrow(/finite numbers in \[0, 1\]/);
    }
  });

  it("requires a finite non-negative tolerance", () => {
    for (const tolerance of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => compareMetrics({ recall: 0.5 }, { recall: 0.5 }, tolerance)).toThrow(/tolerance/);
    }
  });
});
