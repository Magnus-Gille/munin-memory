import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { get } from "node:https";
import { basename, dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

export const RELEASE_TAG = "benchmark-evidence-longmemeval-s-20261018";
export const BASELINE_DIRECTORY = resolve(import.meta.dirname, "baselines/longmemeval-s-20261018");
const NAMES = ["snapshot.db", "queries.jsonl", "query-vectors.json", "build-provenance.json", "manifest.json"];
const DEFAULT_TIMEOUT_MS = 600_000;
interface FilePin { path: string; bytes: number; sha256: string }
export interface SharedManifest { schema_version: 1; release_tag: string; files: (FilePin & { download: { url: string; bytes: number; sha256: string; encoding: "gzip" | "identity" } })[] }
export interface DownloadResponse { statusCode: number; location?: string; body: AsyncIterable<Uint8Array> }
/** Test seam supplies byte streams, never credentials or alternative production URLs. */
export type DownloadTransport = (url: string, signal: AbortSignal) => Promise<DownloadResponse>;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid shared artifact metadata");
  return value as Record<string, unknown>;
}
function pin(value: unknown): FilePin {
  const item = object(value);
  if (typeof item.path !== "string" || !Number.isSafeInteger(item.bytes) || (item.bytes as number) <= 0 || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error("Invalid shared artifact pin");
  return item as unknown as FilePin;
}
function assertUrl(url: string, asset?: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hash
    || (asset !== undefined ? url !== `https://github.com/Magnus-Gille/munin-memory/releases/download/${RELEASE_TAG}/${asset}`
      : parsed.hostname !== "release-assets.githubusercontent.com")) throw new Error("Unsafe shared artifact URL/redirect");
}
export function validateSharedManifest(value: unknown, provenance: unknown): SharedManifest {
  const manifest = object(value); const source = object(provenance); const files = object(source.files);
  if (manifest.schema_version !== 1 || manifest.release_tag !== RELEASE_TAG || !Array.isArray(manifest.files) || manifest.files.length !== NAMES.length) throw new Error("Invalid shared artifact manifest");
  const expected = [files.snapshot, files.queries, files.vectors, files.build_provenance, source.source_manifest].map(pin);
  for (let i = 0; i < NAMES.length; i++) {
    const file = pin(manifest.files[i]); const download = object(object(manifest.files[i]).download);
    if (file.path !== NAMES[i] || file.path !== expected[i].path || file.bytes !== expected[i].bytes || file.sha256 !== expected[i].sha256) throw new Error(`Shared artifact provenance mismatch: ${NAMES[i]}`);
    const encoding = i === 0 ? "gzip" : "identity";
    pin({ ...download, path: file.path });
    if (download.encoding !== encoding || typeof download.url !== "string") throw new Error("Invalid shared artifact download encoding/URL");
    assertUrl(download.url, file.path + (encoding === "gzip" ? ".gz" : ""));
    if (encoding === "identity" && (download.bytes !== file.bytes || download.sha256 !== file.sha256)) throw new Error("Identity download provenance mismatch");
  }
  return manifest as unknown as SharedManifest;
}
function assertRegular(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
  if (!stat.isFile()) throw new Error(`Expected regular artifact file: ${path}`);
}
/** Reject symlink ancestors as well as the leaf, including when the leaf does not exist yet. */
export function assertSafeParents(path: string): void {
  let current = resolve(path);
  for (;;) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
function integrityTransform(expected: Pick<FilePin, "bytes" | "sha256">, label: string): Transform {
  const hash = createHash("sha256"); let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > expected.bytes) { callback(new Error(`Artifact exceeds pinned byte size: ${label}`)); return; }
      hash.update(chunk); callback(null, chunk);
    },
    flush(callback) {
      if (bytes !== expected.bytes) { callback(new Error(`Artifact byte size mismatch: ${label}`)); return; }
      if (hash.digest("hex") !== expected.sha256) { callback(new Error(`Artifact SHA256 mismatch: ${label}`)); return; }
      callback();
    },
  });
}
export async function verifyFile(path: string, expected: Pick<FilePin, "bytes" | "sha256">): Promise<void> {
  assertRegular(path);
  await pipeline(createReadStream(path), integrityTransform(expected, basename(path)), new Transform({ transform(_chunk, _encoding, callback) { callback(); } }));
}
export async function loadSharedContract(directory = BASELINE_DIRECTORY): Promise<{ manifest: SharedManifest; baseline: string; asOf: string; metadataPaths: string[] }> {
  const provenancePath = join(directory, "provenance.json"); const sharedPath = join(directory, "shared-artifacts.json");
  assertRegular(provenancePath); assertRegular(sharedPath);
  const provenance = object(JSON.parse(readFileSync(provenancePath, "utf8")) as unknown);
  const manifest = validateSharedManifest(JSON.parse(readFileSync(sharedPath, "utf8")) as unknown, provenance);
  const baselinePin = pin(provenance.baseline); const verificationPin = pin(provenance.upstream_model_verification);
  if (baselinePin.path !== "baseline.json" || verificationPin.path !== "upstream-model-verification.json") throw new Error("Invalid baseline metadata path");
  const baseline = join(directory, baselinePin.path); const verification = join(directory, verificationPin.path);
  await verifyFile(baseline, baselinePin); await verifyFile(verification, verificationPin);
  const asOf = object(provenance.clock).as_of;
  if (asOf !== "2026-10-01T00:00:00.000Z") throw new Error("Invalid pinned evidence clock");
  return { manifest, baseline, asOf, metadataPaths: [provenancePath, sharedPath, baseline, verification] };
}
const httpsTransport: DownloadTransport = (url, signal) => new Promise((resolveResponse, reject) => {
  // https.get sends no authorization, cookies, proxy credentials or environment-derived headers.
  const request = get(url, { signal, headers: { "User-Agent": "munin-evidence-benchmark", "Accept-Encoding": "identity" } }, (response) => {
    resolveResponse({ statusCode: response.statusCode ?? 0, location: response.headers.location, body: response });
  });
  request.on("error", (error: NodeJS.ErrnoException) => reject(new Error(`Artifact HTTPS request failed (${error.code ?? "network_error"})`)));
});
async function downloadFile(url: string, destination: string, expected: SharedManifest["files"][number]["download"], transport: DownloadTransport, timeoutMs: number): Promise<void> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(new Error("Artifact download timed out")), timeoutMs);
  try {
    let current = url;
    for (let redirects = 0; ; redirects++) {
      const response = await transport(current, controller.signal);
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        // Release assets are served only by GitHub's dedicated asset host. Never forward headers.
        if (redirects >= 3 || !response.location) throw new Error("Invalid artifact redirect");
        const next = new URL(response.location, current).href; assertUrl(next); current = next;
        // Cancel the redirect body without buffering an unbounded response.
        const iterator = response.body[Symbol.asyncIterator](); await iterator.return?.();
        continue;
      }
      if (response.statusCode !== 200) {
        const iterator = response.body[Symbol.asyncIterator](); await iterator.return?.();
        throw new Error(`Artifact download HTTP ${response.statusCode}`);
      }
      await pipeline(response.body, integrityTransform(expected, basename(destination)), createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
      return;
    }
  } finally {
    clearTimeout(timeout);
    // Also close unconsumed redirect/error responses; iterator.return() alone may
    // not start or destroy their underlying HTTP stream. Success is already drained.
    controller.abort();
  }
}
export interface VerificationReceipt { release_tag: string; source: "reused" | "downloaded"; files: FilePin[] }
export async function fetchSharedArtifacts(artifactsDir: string, manifest: SharedManifest, options: { transport?: DownloadTransport; timeoutMs?: number } = {}): Promise<VerificationReceipt> {
  // Validate path/URL/encoding structure even for callers using the test transport seam.
  validateSharedManifest(manifest, { files: { snapshot: manifest.files[0], queries: manifest.files[1], vectors: manifest.files[2], build_provenance: manifest.files[3] }, source_manifest: manifest.files[4] });
  const receipt = (source: VerificationReceipt["source"]): VerificationReceipt => ({ release_tag: manifest.release_tag, source, files: manifest.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) });
  const target = resolve(artifactsDir); assertSafeParents(target);
  const parent = dirname(target);
  if (!lstatSync(parent).isDirectory()) throw new Error("Artifact directory parent must exist");
  let existing = false;
  try { existing = lstatSync(target).isDirectory(); if (!existing) throw new Error("Artifact target must be a directory"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing) {
    const names = readdirSync(target);
    if (names.length !== NAMES.length || names.some((name) => !NAMES.includes(name))) throw new Error("Artifact directory contains missing or unexpected files/sidecars");
    for (const file of manifest.files) await verifyFile(join(target, file.path), file);
    return receipt("reused");
  }
  const stage = mkdtempSync(join(parent, `.${basename(target)}-stage-`));
  try {
    for (const file of manifest.files) {
      const destination = join(stage, file.path);
      if (!NAMES.includes(file.path)) throw new Error("Invalid artifact path");
      const compressed = file.download.encoding === "gzip" ? join(stage, ".snapshot.db.gz") : destination;
      await downloadFile(file.download.url, compressed, file.download, options.transport ?? httpsTransport, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      if (file.download.encoding === "gzip") {
        await pipeline(createReadStream(compressed), createGunzip(), integrityTransform(file, file.path), createWriteStream(destination, { flags: "wx", mode: 0o600 }));
        rmSync(compressed);
      }
      await verifyFile(destination, file);
    }
    assertSafeParents(target);
    // A directory created by someone else during download is never replaced.
    try { lstatSync(target); throw new Error("Artifact target appeared during download"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    renameSync(stage, target);
    return receipt("downloaded");
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
