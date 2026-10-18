import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { fetchSharedArtifacts, loadSharedContract, validateSharedManifest, type SharedManifest, type DownloadTransport } from "../benchmark/evidence-metric/shared-artifacts.js";

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
let dir: string;
let payloads: Map<string, Buffer>;
let manifest: SharedManifest;
let provenance: Record<string, unknown>;
const tag = "benchmark-evidence-longmemeval-s-20261018";
const paths = ["snapshot.db", "queries.jsonl", "query-vectors.json", "build-provenance.json", "manifest.json"];
const target = () => join(dir, "artifacts");
const transport: DownloadTransport = async (url) => ({ statusCode: 200, body: (async function* () { yield payloads.get(url)!; })() });
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "munin-evidence-shared-"))); payloads = new Map();
  manifest = { schema_version: 1, release_tag: tag, files: paths.map((path, i) => {
    const bytes = Buffer.from(`fixture-${path}`); const compressed = i === 0 ? gzipSync(bytes) : bytes;
    const url = `https://github.com/Magnus-Gille/munin-memory/releases/download/${tag}/${path}${i === 0 ? ".gz" : ""}`;
    payloads.set(url, compressed);
    return { path, bytes: bytes.length, sha256: hash(bytes), download: { url, bytes: compressed.length, sha256: hash(compressed), encoding: i === 0 ? "gzip" : "identity" } };
  }) };
  provenance = { files: Object.fromEntries(["snapshot", "queries", "vectors", "build_provenance"].map((key, i) => [key, { path: manifest.files[i].path, bytes: manifest.files[i].bytes, sha256: manifest.files[i].sha256 }])), source_manifest: { path: manifest.files[4].path, bytes: manifest.files[4].bytes, sha256: manifest.files[4].sha256 } };
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe("pinned shared evidence inputs", () => {
  it("cross-checks all five local provenance bindings and fixed release URLs", () => {
    expect(validateSharedManifest(manifest, provenance)).toEqual(manifest);
    const changed = structuredClone(manifest); changed.files[0].sha256 = "0".repeat(64);
    expect(() => validateSharedManifest(changed, provenance)).toThrow(/provenance/);
    for (const url of ["http://github.com/no", "https://evil.example/a", manifest.files[0].download.url + "?token=no"]) {
      const bad = structuredClone(manifest); bad.files[0].download.url = url;
      expect(() => validateSharedManifest(bad, provenance)).toThrow(/URL/);
    }
  });
  it("verifies committed baseline and upstream model receipt hashes before use", async () => {
    const baseline = Buffer.from("baseline"); const upstream = Buffer.from("upstream");
    writeFileSync(join(dir, "baseline.json"), baseline); writeFileSync(join(dir, "upstream-model-verification.json"), upstream);
    const metadata = { ...provenance, clock: { as_of: "2026-10-01T00:00:00.000Z" }, baseline: { path: "baseline.json", bytes: baseline.length, sha256: hash(baseline) }, upstream_model_verification: { path: "upstream-model-verification.json", bytes: upstream.length, sha256: hash(upstream) } };
    writeFileSync(join(dir, "provenance.json"), JSON.stringify(metadata)); writeFileSync(join(dir, "shared-artifacts.json"), JSON.stringify(manifest));
    expect((await loadSharedContract(dir)).baseline).toBe(join(dir, "baseline.json"));
    writeFileSync(join(dir, "baseline.json"), "badbytes"); await expect(loadSharedContract(dir)).rejects.toThrow(/SHA/);
    writeFileSync(join(dir, "baseline.json"), baseline); writeFileSync(join(dir, "upstream-model-verification.json"), "badbytes"); await expect(loadSharedContract(dir)).rejects.toThrow(/SHA/);
  });
  it("verifies compressed transfer then final bytes, atomically installs and reuses verified files", async () => {
    const download = vi.fn(transport);
    await fetchSharedArtifacts(target(), manifest, { transport: download });
    expect(readFileSync(join(target(), "snapshot.db"), "utf8")).toBe("fixture-snapshot.db");
    expect(readdirSync(target()).sort()).toEqual([...paths].sort());
    await fetchSharedArtifacts(target(), manifest, { transport: download });
    expect(download).toHaveBeenCalledTimes(5);
    expect(readdirSync(dir)).toEqual(["artifacts"]);
  });
  it.each(["wrong-hash", "truncated", "oversize", "interrupted"])("rejects %s transfers with no partial target or staging left", async (kind) => {
    const first = manifest.files[0]; const correct = payloads.get(first.download.url)!;
    if (kind === "wrong-hash") { const value = Buffer.from(correct); value[0] ^= 1; payloads.set(first.download.url, value); }
    if (kind === "truncated") payloads.set(first.download.url, correct.subarray(0, correct.length - 1));
    if (kind === "oversize") payloads.set(first.download.url, Buffer.concat([correct, Buffer.from("x")]));
    const broken: DownloadTransport = kind === "interrupted" ? async () => ({ statusCode: 200, body: (async function* () { yield correct.subarray(0, 5); throw new Error("interrupted"); })() }) : transport;
    await expect(fetchSharedArtifacts(target(), manifest, { transport: broken })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
  it("rejects final decompressed hash mismatch", async () => {
    manifest.files[0].sha256 = "0".repeat(64);
    await expect(fetchSharedArtifacts(target(), manifest, { transport })).rejects.toThrow(/SHA/);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("preserves existing corrupt directories and refuses symlink targets, files and sidecars", async () => {
    mkdirSync(target()); writeFileSync(join(target(), "mine"), "preserve");
    await expect(fetchSharedArtifacts(target(), manifest, { transport })).rejects.toThrow();
    expect(readFileSync(join(target(), "mine"), "utf8")).toBe("preserve"); rmSync(target(), { recursive: true });
    symlinkSync(dir, target());
    await expect(fetchSharedArtifacts(target(), manifest, { transport })).rejects.toThrow(/symlink/); rmSync(target());
    await fetchSharedArtifacts(target(), manifest, { transport });
    writeFileSync(join(target(), "snapshot.db-wal"), "sidecar");
    await expect(fetchSharedArtifacts(target(), manifest, { transport })).rejects.toThrow(/sidecar|unexpected/);
    rmSync(join(target(), "snapshot.db-wal")); rmSync(join(target(), "queries.jsonl")); symlinkSync(join(target(), "snapshot.db"), join(target(), "queries.jsonl"));
    await expect(fetchSharedArtifacts(target(), manifest, { transport })).rejects.toThrow(/symlink/);
  });
  it("requires safe redirects and rejects status/redirect loops", async () => {
    const first = manifest.files[0];
    for (const location of ["http://release-assets.githubusercontent.com/a", "https://evil.example/a", "https://github.com/login", "https://user:pass@release-assets.githubusercontent.com/a"]) {
      const redirect: DownloadTransport = async () => ({ statusCode: 302, location, body: (async function* () {})() });
      await expect(fetchSharedArtifacts(target(), manifest, { transport: redirect })).rejects.toThrow(/redirect|URL/);
    }
    const looping: DownloadTransport = async () => ({ statusCode: 302, location: first.download.url, body: (async function* () {})() });
    await expect(fetchSharedArtifacts(target(), manifest, { transport: looping })).rejects.toThrow(/redirect/);
  });
  it("accepts only the approved asset-host redirect and enforces a download timeout", async () => {
    const first = manifest.files[0]; const redirected = "https://release-assets.githubusercontent.com/frozen?signature=fixture";
    const safe: DownloadTransport = async (url) => url === first.download.url
      ? { statusCode: 302, location: redirected, body: (async function* () {})() }
      : { statusCode: 200, body: (async function* () { yield payloads.get(url === redirected ? first.download.url : url)!; })() };
    await fetchSharedArtifacts(target(), manifest, { transport: safe });
    rmSync(target(), { recursive: true });
    const stalled: DownloadTransport = async (_url, signal) => ({ statusCode: 200, body: (async function* () { await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })); yield Buffer.from("unreachable"); })() });
    await expect(fetchSharedArtifacts(target(), manifest, { transport: stalled, timeoutMs: 5 })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
  it.each(["rejected redirect", "HTTP error", "success"])("cancels request signals after %s, including unconsumed response bodies", async (scenario) => {
    const signals: AbortSignal[] = [];
    let openResponses = 0;
    const observe: DownloadTransport = async (url, signal) => {
      signals.push(signal); openResponses += 1;
      signal.addEventListener("abort", () => { openResponses -= 1; }, { once: true });
      if (scenario === "rejected redirect") return { statusCode: 302, location: "https://evil.example/forbidden", body: (async function* () {})() };
      if (scenario === "HTTP error") return { statusCode: 503, body: (async function* () {})() };
      return transport(url, signal);
    };
    if (scenario === "success") await fetchSharedArtifacts(target(), manifest, { transport: observe });
    else await expect(fetchSharedArtifacts(target(), manifest, { transport: observe })).rejects.toThrow();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(openResponses).toBe(0);
  });

});
