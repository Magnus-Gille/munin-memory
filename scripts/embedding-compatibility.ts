import Database from "better-sqlite3";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { previewEmbeddingCompatibility } from "../src/db.js";
import { getActiveEmbeddingModel, getConfiguredEmbeddingIdentity } from "../src/embeddings.js";

/** Local owner audit: never initializes a database, migrations, worker or model. */
export function previewDatabase(path: string) {
  const identity = getConfiguredEmbeddingIdentity();
  if (identity === null) throw new Error("Embedding identity is unavailable; configure an immutable model revision and installed runtime metadata first.");
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return {
      mode: "read_only_preview" as const,
      identity: JSON.parse(identity) as unknown,
      counts: previewEmbeddingCompatibility(db, getActiveEmbeddingModel(), identity, true),
    };
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== "--db" || !process.argv[3]) {
    console.error("Usage: node --import tsx scripts/embedding-compatibility.ts --db <existing-database-or-snapshot>");
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(previewDatabase(process.argv[3]), null, 2));
    } catch {
      console.error("Compatibility preview unavailable. Check the existing database path, schema, immutable model revision, and installed dependencies. No migration or model initialization was attempted.");
      process.exitCode = 1;
    }
  }
}
