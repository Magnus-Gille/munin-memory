import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { initDatabase, patchState } from "../../src/db.js";

const [dbPath, goPath, readyPath, namespace, key, appendText, expectedUpdatedAt] = process.argv.slice(2);
if (!dbPath || !goPath || !readyPath || !namespace || !key || !appendText) {
  throw new Error("Expected db path, gate path, ready path, namespace, key, and append text");
}

const db = initDatabase(dbPath);
try {
  writeFileSync(readyPath, "ready", { mode: 0o600 });
  while (!existsSync(goPath)) {
    await delay(5);
  }

  const result = patchState(
    db,
    namespace,
    key,
    { content_append: appendText },
    appendText,
    expectedUpdatedAt || undefined,
  );
  process.stdout.write(JSON.stringify(result));
} finally {
  db.close();
}
