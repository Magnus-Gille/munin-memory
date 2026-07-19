/**
 * MUNIN_PROFILE preset resolver — a pure mapping from a profile name to default
 * knob values + feature posture, for the three appliance tiers in
 * docs/appliance-profiles.md.
 *
 * Provenance: the per-tier defaults below are taken directly from the
 * 2026-06-18 RAM-fit sweep (benchmark/ramfit/FINDINGS.md). The decisive result:
 * q8 MiniLM semantic search fits with large headroom on a 512MB-class board
 * (peak anon ~74-99MB across query/write/concurrent; ~91-94MB under sustained
 * burst at appliance caps; fits even a 128MB cgroup cap). So
 * the cheapest primary tier (zero-appliance) keeps semantic ON with quantised
 * weights rather than falling back to lexical-only.
 *
 * Precedence (resolveKnob): explicit env var > profile default > hard default.
 * With MUNIN_PROFILE unset, every profile default is undefined, so resolveKnob
 * collapses to exactly `env ?? hardDefault` — byte-for-byte current behavior.
 *
 * This module is intentionally a small pure function with no I/O, no classes,
 * and no dependencies, so it is trivially testable and safe to import anywhere.
 */

export const PROFILE_NAMES = ["zero-appliance", "zero-plus", "full-node"] as const;

export type ProfileName = (typeof PROFILE_NAMES)[number];

/**
 * The knobs a profile may set. Values are strings because they are merged with
 * the environment, which is always string-valued. A knob the profile chooses
 * NOT to set is omitted (undefined), so the existing hard default wins.
 */
export interface ProfileKnobs {
  MUNIN_EMBEDDINGS_ENABLED?: string;
  MUNIN_EMBEDDINGS_MODEL?: string;
  MUNIN_EMBEDDINGS_DTYPE?: string;
  MUNIN_EMBEDDINGS_BATCH_SIZE?: string;
  MUNIN_SQLITE_CACHE_KIB?: string;
  MUNIN_SQLITE_MMAP_BYTES?: string;
}

export interface ResolvedProfile {
  knobs: ProfileKnobs;
  /** Feature posture: true = semantic ON, false = lexical-only, null = no opinion (unset profile). */
  semantic: boolean | null;
}

/**
 * Canonical per-tier defaults, chosen from the RAM-fit sweep.
 *
 * - zero-appliance (Pi 3A+ / Pi Zero 2 W, 512MB-class — the cheapest primary
 *   target): semantic ON via q8 MiniLM, batch=1, lean SQLite page cache, mmap
 *   off. Peak anon ~74-99MB across query/write/concurrent (~91-94MB under
 *   sustained burst at appliance caps); fits a 128MB cgroup cap with headroom.
 * - zero-plus (Pi 5 2GB-class): semantic ON via q8 MiniLM, batch=4 and a larger
 *   page cache since there is more headroom. Peak anon ~74-99MB (same model/dtype
 *   as zero-appliance; burst at 1024MB cap peaks ~99MB).
 * - full-node (Pi 4/5 4GB+, mini PC, VPS): full-fidelity fp32 semantic, no
 *   memory clamps. Leaves DTYPE / cache / mmap UNSET so the existing hard
 *   defaults flow through unchanged.
 */
const PROFILE_DEFAULTS: Record<ProfileName, ResolvedProfile> = {
  "zero-appliance": {
    knobs: {
      MUNIN_EMBEDDINGS_ENABLED: "true",
      MUNIN_EMBEDDINGS_MODEL: "Xenova/all-MiniLM-L6-v2",
      MUNIN_EMBEDDINGS_DTYPE: "q8",
      MUNIN_EMBEDDINGS_BATCH_SIZE: "1",
      MUNIN_SQLITE_CACHE_KIB: "1024",
      MUNIN_SQLITE_MMAP_BYTES: "0",
    },
    semantic: true,
  },
  "zero-plus": {
    knobs: {
      MUNIN_EMBEDDINGS_ENABLED: "true",
      MUNIN_EMBEDDINGS_MODEL: "Xenova/all-MiniLM-L6-v2",
      MUNIN_EMBEDDINGS_DTYPE: "q8",
      MUNIN_EMBEDDINGS_BATCH_SIZE: "4",
      MUNIN_SQLITE_CACHE_KIB: "4096",
      MUNIN_SQLITE_MMAP_BYTES: "0",
    },
    semantic: true,
  },
  "full-node": {
    knobs: {
      MUNIN_EMBEDDINGS_ENABLED: "true",
      // DTYPE / CACHE_KIB / MMAP_BYTES deliberately unset → hard defaults win.
    },
    semantic: true,
  },
};

const EMPTY_PROFILE: ResolvedProfile = { knobs: {}, semantic: null };

function isProfileName(name: string | undefined): name is ProfileName {
  return name !== undefined && (PROFILE_NAMES as readonly string[]).includes(name);
}

/**
 * Resolve a profile name to its knob defaults + feature posture. An unset,
 * empty, or unrecognized name resolves to an empty knob set with no posture —
 * which makes resolveKnob a no-op (current behavior preserved).
 */
export function resolveProfile(name: string | undefined): ResolvedProfile {
  if (!isProfileName(name)) return EMPTY_PROFILE;
  return PROFILE_DEFAULTS[name];
}

type EnvLike = Record<string, string | undefined>;

/**
 * Resolve a single knob with precedence: explicit env var > active profile
 * default > hard default.
 *
 * - `envKey` — the environment variable name (also the ProfileKnobs key).
 * - `hardDefault` — the value used when neither env nor profile sets the knob.
 * - `env` — environment source (defaults to process.env). Injectable for tests.
 *
 * NOTE on `??` semantics: the existing code reads `process.env.X ?? default`,
 * which treats an empty string as a present value. resolveKnob preserves that —
 * only `undefined` (truly unset) falls through to the profile/hard default.
 */
export function resolveKnob(
  envKey: keyof ProfileKnobs,
  hardDefault: string | undefined,
  env: EnvLike = process.env,
): string | undefined {
  const explicit = env[envKey];
  if (explicit !== undefined) return explicit;

  const profile = resolveProfile(env.MUNIN_PROFILE);
  const fromProfile = profile.knobs[envKey];
  if (fromProfile !== undefined) return fromProfile;

  return hardDefault;
}

/**
 * Convenience: the resolved feature posture for the active profile (from env).
 * Returns null when no profile is set (no opinion).
 */
export function activeProfileSemantic(env: EnvLike = process.env): boolean | null {
  return resolveProfile(env.MUNIN_PROFILE).semantic;
}
