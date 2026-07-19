/**
 * Owner-specific compatibility knobs.
 *
 * Public installations use the generic `owner` identity, while existing Munin
 * databases and deployments may contain an older owner namespace/name. Keep the
 * compatibility values centralized so publication-safe defaults do not strand
 * existing data or weaken owner-directed injection detection.
 */

const DEFAULT_OWNER_PROFILE_NAMESPACE = "people/owner";
const LEGACY_OWNER_PROFILE_NAMESPACE = "people/magnus";
const LEGACY_OWNER_ALIASES = ["magnus"];
const OWNER_PROFILE_NAMESPACE_RE = /^people\/[a-zA-Z0-9][a-zA-Z0-9/_-]*$/;
const MAX_OWNER_ALIASES = 20;
const MAX_OWNER_ALIAS_LENGTH = 64;

type EnvLike = Record<string, string | undefined>;

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.toLocaleLowerCase("en-US");
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/**
 * Owner names that should be recognized in natural-language security and
 * orientation checks. Configured aliases extend, rather than replace, the
 * compatibility aliases.
 */
export function resolveOwnerAliases(env: EnvLike = process.env): string[] {
  const configured = (env.MUNIN_OWNER_ALIASES ?? "")
    .split(",")
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0 && alias.length <= MAX_OWNER_ALIAS_LENGTH)
    .slice(0, MAX_OWNER_ALIASES);

  return uniqueCaseInsensitive([...LEGACY_OWNER_ALIASES, ...configured]);
}

/**
 * Canonical profile lookup order. A configured namespace wins, followed by the
 * public generic namespace and finally the legacy namespace used by existing
 * databases. Invalid configured values are ignored rather than queried.
 */
export function resolveOwnerProfileNamespaces(env: EnvLike = process.env): string[] {
  const configured = env.MUNIN_OWNER_PROFILE_NAMESPACE?.trim();
  const candidates = [
    configured && OWNER_PROFILE_NAMESPACE_RE.test(configured) ? configured : undefined,
    DEFAULT_OWNER_PROFILE_NAMESPACE,
    LEGACY_OWNER_PROFILE_NAMESPACE,
  ].filter((value): value is string => value !== undefined);

  return uniqueCaseInsensitive(candidates);
}
