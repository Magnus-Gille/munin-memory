let clockActive = false;

/**
 * Run an evaluation callback with a process-wide fixed Date clock.
 * Do not use this in the deployed server: a global clock cannot be isolated
 * between concurrent requests, so nested and overlapping calls are rejected.
 */
export async function withEvaluationClock<T>(
  instant: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (typeof instant !== "string") {
    throw new RangeError("Evaluation clock instant must be a valid date string.");
  }
  const epoch = Date.parse(instant);
  if (!Number.isFinite(epoch)) {
    throw new RangeError("Evaluation clock instant must be a valid date string.");
  }
  if (clockActive) {
    throw new Error("Evaluation clock is already active.");
  }

  const nativeDate = globalThis.Date;
  const frozenDate = new Proxy(nativeDate, {
    construct(target, argumentsList, newTarget) {
      const args = argumentsList.length === 0 ? [epoch] : argumentsList;
      return Reflect.construct(target, args, newTarget);
    },
    get(target, property, receiver) {
      if (property === "now") return () => epoch;
      return Reflect.get(target, property, receiver);
    },
  });

  // Set this before publishing the proxy so a nested callback cannot enter.
  clockActive = true;
  globalThis.Date = frozenDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = nativeDate;
    clockActive = false;
  }
}
