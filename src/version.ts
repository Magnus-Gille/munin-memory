import { createRequire } from "node:module";

interface PackageMetadata {
  version?: unknown;
}

const packageMetadata = createRequire(import.meta.url)("../package.json") as PackageMetadata;

if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error("package.json must define a non-empty version");
}

/** Single runtime version source for MCP handshakes and status responses. */
export const SERVER_VERSION = packageMetadata.version;
