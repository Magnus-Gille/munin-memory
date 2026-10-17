import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const BUILTIN_REVISIONS: Readonly<Record<string, string>> = {
  "Xenova/bge-small-en-v1.5": "ea104dacec62c0de699686887e3f920caeb4f3e3",
  "Xenova/all-MiniLM-L6-v2": "751bff37182d3f1213fa05d7196b954e230abad9",
};

export interface EmbeddingRuntimeVersions {
  transformers: string;
  onnxruntimeNode: string;
}

export interface EmbeddingIdentityConfig {
  model: string;
  revision?: string;
  dtype?: string;
}

export interface ResolvedEmbeddingIdentity {
  identity: string | null;
  reason: string | null;
  revision: string | null;
  dtype: string;
}

const REVISION_REASON = "Embedding identity unavailable: set MUNIN_EMBEDDINGS_REVISION to an immutable 40-character hexadecimal model revision";
const RUNTIME_REASON = "Embedding identity unavailable: installed Transformers and onnxruntime-node package versions could not be verified";

function readPackageVersion(path: string, expectedName: string): string | null {
  const metadata: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (metadata === null || typeof metadata !== "object") return null;
  const { name, version } = metadata as { name?: unknown; version?: unknown };
  return name === expectedName && typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(version)
    ? version : null;
}

/** Read metadata only; resolving a module does not import its native/runtime code. */
export function readInstalledEmbeddingRuntimeVersions(): EmbeddingRuntimeVersions | null {
  try {
    // Transformers does not export package.json. Its resolved entry is in dist/.
    const transformers = readPackageVersion(
      join(dirname(require.resolve("@huggingface/transformers")), "..", "package.json"),
      "@huggingface/transformers",
    );
    const onnxruntimeNode = readPackageVersion(
      require.resolve("onnxruntime-node/package.json"), "onnxruntime-node",
    );
    return transformers !== null && onnxruntimeNode !== null ? { transformers, onnxruntimeNode } : null;
  } catch {
    // Missing or invalid metadata must disable compatibility claims, not guess.
    return null;
  }
}

/** Stable, complete manifest. Equality is deliberately conservative until a gold evaluation proves aliases safe. */
export function resolveEmbeddingIdentity(
  config: EmbeddingIdentityConfig,
  runtime: EmbeddingRuntimeVersions | null = readInstalledEmbeddingRuntimeVersions(),
): ResolvedEmbeddingIdentity {
  const dtype = config.dtype || "fp32";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.model)) {
    return { identity: null, reason: "Embedding identity unavailable: MUNIN_EMBEDDINGS_MODEL must be a Hugging Face owner/repository ID; local paths and URLs are unsupported", revision: null, dtype };
  }
  const revision = config.revision === undefined
    ? BUILTIN_REVISIONS[config.model] : config.revision;
  if (revision === undefined || !/^[a-fA-F0-9]{40}$/.test(revision)) {
    return { identity: null, reason: REVISION_REASON, revision: null, dtype };
  }
  if (runtime === null) return { identity: null, reason: RUNTIME_REASON, revision: null, dtype };
  const normalizedRevision = revision.toLowerCase();
  const identity = JSON.stringify({
    version: 1,
    model: config.model,
    revision: normalizedRevision,
    dtype,
    dimensions: 384,
    pooling: "mean",
    normalize: true,
    preprocessing: "raw-text-v1",
    transformers_version: runtime.transformers,
    onnxruntime_node_version: runtime.onnxruntimeNode,
    platform: process.platform,
    arch: process.arch,
    execution_provider: "cpu",
  });
  return { identity, reason: null, revision: normalizedRevision, dtype };
}
