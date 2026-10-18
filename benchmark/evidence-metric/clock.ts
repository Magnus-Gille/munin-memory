/** Benchmark-only clock, adapted from the unmerged #336 continuous-eval design.
 * Serialize callers: a process-wide Date proxy cannot safely overlap evaluations.
 */
let active = false;

export function normalizeAsOf(value: string): string {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new Error("as-of must be an explicit ISO timestamp with timezone");
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error("Invalid as-of timestamp");
  return new Date(epoch).toISOString();
}

export async function withFrozenClock<T>(asOf: string, run: () => Promise<T>): Promise<T> {
  if (active) throw new Error("Frozen benchmark clocks cannot overlap or nest");
  const epoch = Date.parse(normalizeAsOf(asOf));
  const nativeDate = Date;
  active = true;
  globalThis.Date = new Proxy(nativeDate, {
    construct(target, args) { return Reflect.construct(target, args.length === 0 ? [epoch] : args); },
    apply() { return new nativeDate(epoch).toString(); },
    get(target, property, receiver) {
      return property === "now" ? () => epoch : Reflect.get(target, property, receiver);
    },
  });
  try {
    return await run();
  } finally {
    globalThis.Date = nativeDate;
    active = false;
  }
}
