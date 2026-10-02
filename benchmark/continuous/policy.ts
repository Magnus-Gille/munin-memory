export interface MetricDelta {
  metric: string;
  current: number;
  baseline: number;
}

export interface MetricComparison {
  status: "unchanged" | "improved" | "regressed";
  regressions: MetricDelta[];
  improvements: MetricDelta[];
}

/**
 * Compare bounded score ratios. A single regression takes precedence over
 * improvements elsewhere so aggregate movement cannot hide a lost metric.
 */
export function compareMetrics(
  current: Record<string, number>,
  baseline: Record<string, number>,
  tolerance = 1e-9,
): MetricComparison {
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError("tolerance must be a finite non-negative number");
  }

  const isMetricRecord = (value: unknown): value is Record<string, number> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isMetricRecord(current) || !isMetricRecord(baseline)) {
    throw new TypeError("current and baseline must be metric records");
  }

  const metrics = Object.keys(current).sort();
  const baselineMetrics = Object.keys(baseline).sort();
  if (metrics.length === 0 || baselineMetrics.length === 0) {
    throw new TypeError("current and baseline must each contain at least one metric");
  }
  if (
    metrics.length !== baselineMetrics.length ||
    metrics.some((metric, index) => metric !== baselineMetrics[index])
  ) {
    throw new TypeError("current and baseline must contain exactly the same metric keys");
  }

  const regressions: MetricDelta[] = [];
  const improvements: MetricDelta[] = [];
  for (const metric of metrics) {
    const currentValue = current[metric];
    const baselineValue = baseline[metric];
    if (
      !Number.isFinite(currentValue) ||
      currentValue < 0 ||
      currentValue > 1 ||
      !Number.isFinite(baselineValue) ||
      baselineValue < 0 ||
      baselineValue > 1
    ) {
      throw new RangeError(`metric "${metric}" values must be finite numbers in [0, 1]`);
    }

    if (currentValue < baselineValue - tolerance) {
      regressions.push({ metric, current: currentValue, baseline: baselineValue });
    } else if (currentValue > baselineValue + tolerance) {
      improvements.push({ metric, current: currentValue, baseline: baselineValue });
    }
  }

  const status = regressions.length > 0
    ? "regressed"
    : improvements.length > 0
      ? "improved"
      : "unchanged";
  return { status, regressions, improvements };
}
