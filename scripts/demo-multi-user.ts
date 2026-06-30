/**
 * Demo: multi-user Munin — three principals, three worlds.
 *
 *   npx tsx scripts/demo-multi-user.ts
 *
 * Shows the feature shipped on `feat/multi-user-conventions` (ADR 0001 / #157 / #5):
 *   - per-principal CONVENTIONS resolution (owner / principal / universal default)
 *   - per-principal DASHBOARD taxonomy (configurable tracked patterns)
 *   - profile ONBOARDING (`munin-admin principals add --profile`)
 *
 * The owner, a household family member, and an external user each orient into
 * their OWN conventions and a dashboard scoped to their OWN namespaces — fully
 * isolated. Runs entirely in-memory; embeddings disabled so it's fast + offline.
 */

// Disable the background embedding worker/model load — the demo only needs
// lexical orient/dashboard, and we want it fast and offline.
process.env.MUNIN_EMBEDDINGS_ENABLED = "false";

import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initDatabase, writeState } from "../src/db.js";
import { registerTools } from "../src/tools.js";
import { addPrincipal } from "../src/admin-cli.js";
import { ownerContext, type AccessContext } from "../src/access.js";

type Call = (name: string, args?: Record<string, unknown>) => Promise<unknown>;
type OrientResult = {
  conventions?: { source?: string; content?: string } | null;
  dashboard?: Record<string, Array<{ namespace: string }>>;
};

function makeCall(db: Database.Database, ctx: AccessContext): Call {
  const server = new Server({ name: "demo", version: "0.0.0" }, { capabilities: { tools: {} } });
  registerTools(server, db, undefined, ctx);
  const handler = (
    server as unknown as { _requestHandlers: Map<string, (req: unknown) => Promise<unknown>> }
  )._requestHandlers.get("tools/call");
  if (!handler) throw new Error("tools/call handler not found");
  return (name, args = {}) => handler({ method: "tools/call", params: { name, arguments: args } });
}

function parseOrient(res: unknown): OrientResult {
  return JSON.parse((res as { content: Array<{ text: string }> }).content[0].text) as OrientResult;
}

function scopedCtx(principalId: string, type: "family" | "external", home: string): AccessContext {
  return { principalId, principalType: type, accessibleNamespaces: [{ pattern: `${home}/*`, permissions: "rw" }] };
}

async function show(label: string, call: Call): Promise<void> {
  const compact = parseOrient(await call("memory_orient"));
  const full = parseOrient(await call("memory_orient", { include_full_conventions: true }));
  const heading =
    (full.conventions?.content ?? "").split("\n").find((l) => l.startsWith("#")) ?? "(none)";
  const dash = Object.entries(full.dashboard ?? {}).flatMap(([lifecycle, items]) =>
    items.map((i) => `${i.namespace}  [${lifecycle}]`),
  );
  console.log(`\n━━━ ${label} ━━━`);
  console.log(`  conventions.source : ${compact.conventions?.source ?? "(null)"}`);
  console.log(`  conventions (full) : ${heading}`);
  console.log(`  dashboard          : ${dash.length ? dash.join("\n                       ") : "(empty)"}`);
}

async function main(): Promise<void> {
  const db = initDatabase(":memory:");

  // --- Owner (Magnus): global conventions + tracked consultant work ---
  writeState(
    db,
    "meta/conventions",
    "conventions",
    "# Magnus — Munin Conventions\nConsultant taxonomy: projects/* and clients/*.",
    ["governance"],
  );
  writeState(db, "projects/munin", "status", "Building multi-user memory", ["active"]);
  writeState(db, "clients/acme", "status", "Engagement active", ["active"]);

  // --- Sara (family): onboarded with the household profile ---
  addPrincipal(db, {
    principalId: "sara",
    principalType: "family",
    rules: [{ pattern: "users/sara/*", permissions: "rw" }],
    profile: "household",
  });
  writeState(db, "users/sara/home/garden", "status", "Replant the back beds", ["active"], "sara");
  writeState(db, "users/sara/health/checkup", "status", "Book annual checkup", ["active"], "sara");

  // --- Guest (external): onboarded with the personal-knowledge profile ---
  addPrincipal(db, {
    principalId: "guest",
    principalType: "external",
    rules: [{ pattern: "users/guest/*", permissions: "rw" }],
    profile: "personal-knowledge",
  });
  writeState(db, "users/guest/projects/novel", "status", "Draft chapter 3", ["active"], "guest");

  console.log("\n=== Munin multi-user demo — three principals, three worlds ===");
  await show("OWNER (Magnus)", makeCall(db, ownerContext()));
  await show("FAMILY (Sara — household profile)", makeCall(db, scopedCtx("sara", "family", "users/sara")));
  await show("EXTERNAL (Guest — personal-knowledge profile)", makeCall(db, scopedCtx("guest", "external", "users/guest")));

  console.log(
    "\nEach principal saw only their own conventions (note `source`) and a dashboard\n" +
      "scoped to their own namespaces. The owner workspace is fully isolated from the\n" +
      "family and external workspaces — same store, three coherent worlds.\n",
  );

  db.close();
  process.exit(0);
}

void main();
