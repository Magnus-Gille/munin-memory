import { mkdirSync, mkdtempSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import type { env as TransformersEnv } from "@huggingface/transformers";

type ModelSourceEnv = Pick<typeof TransformersEnv,
  "localModelPath" | "allowLocalModels" | "allowRemoteModels" | "cacheDir" |
  "useFSCache" | "useBrowserCache" | "useCustomCache" | "remoteHost" | "remotePathTemplate">;
let sourceLoadQueue: Promise<void> = Promise.resolve();

/**
 * Transformers ignores revisions for local models, but rejects cache-only loads
 * when allowLocalModels=false. Give it a fresh empty local source root instead:
 * only the revision-scoped FileCache or pinned Hub URL can provide model files.
 * Serialize our loads because Transformers env is process-global.
 */
export async function withPinnedEmbeddingSource<T>(env: ModelSourceEnv, cacheDir: string, load: () => Promise<T>): Promise<T> {
  const previousLoad = sourceLoadQueue;
  let release!: () => void;
  sourceLoadQueue = new Promise<void>((resolve) => { release = resolve; });
  await previousLoad;
  const previous: ModelSourceEnv = {
    localModelPath: env.localModelPath, allowLocalModels: env.allowLocalModels,
    allowRemoteModels: env.allowRemoteModels, cacheDir: env.cacheDir,
    useFSCache: env.useFSCache, useBrowserCache: env.useBrowserCache,
    useCustomCache: env.useCustomCache, remoteHost: env.remoteHost,
    remotePathTemplate: env.remotePathTemplate,
  };
  let emptyRoot: string | undefined;
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    emptyRoot = mkdtempSync(join(cacheDir, ".munin-empty-model-source-"));
    Object.assign(env, {
      localModelPath: emptyRoot, allowLocalModels: true,
      cacheDir, useFSCache: true, useBrowserCache: false, useCustomCache: false,
      remoteHost: "https://huggingface.co/", remotePathTemplate: "{model}/resolve/{revision}/",
    });
    return await load();
  } finally {
    try {
      Object.assign(env, previous);
      // The model loader only reads this root. Never recursively remove content
      // if an unexpected writer has populated our private empty directory.
      if (emptyRoot !== undefined) rmdirSync(emptyRoot);
    } finally {
      release();
    }
  }
}
