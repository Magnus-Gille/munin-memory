import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { initDatabase, writeState } from "../../src/db.js";

const [dbPath, goPath, readyPath, label] = process.argv.slice(2);
if (!dbPath || !goPath || !readyPath || !label) {
  throw new Error("Expected db path, gate path, ready path, and writer label");
}

const db = initDatabase(dbPath);
try {
  writeFileSync(readyPath, "ready", { mode: 0o600 });
  while (!existsSync(goPath)) {
    await delay(5);
  }

  const result = writeState(
    db,
    "feedback/tasks/race",
    "receipt-ledger",
    label,
    ["quality:receipt-v1"],
    label,
    undefined,
    undefined,
    { createIfAbsent: true },
  );
  process.stdout.write(JSON.stringify(result));
} finally {
  db.close();
}
