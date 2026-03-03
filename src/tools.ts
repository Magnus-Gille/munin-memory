import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import {
  writeState,
  readState,
  getById,
  appendLog,
  queryEntries,
  queryEntriesSemantic,
  queryEntriesHybrid,
  listNamespaces,
  listNamespaceContents,
  previewDelete,
  executeDelete,
  getOtherKeysInNamespace,
  vecLoaded,
} from "./db.js";
import {
  validateWriteInput,
  validateLogInput,
  validateNamespace,
  validateKey,
} from "./security.js";
import {
  generateEmbedding,
  embeddingToBuffer,
  isSemanticEnabled,
  isHybridEnabled,
  getEmbeddingStatusReason,
} from "./embeddings.js";
import type {
  WriteParams,
  ReadParams,
  ReadBatchParams,
  GetParams,
  QueryParams,
  LogParams,
  ListParams,
  DeleteParams,
  Entry,
  SearchMode,
} from "./types.js";

// In-memory delete token store (debate resolution #9)
const deleteTokens = new Map<string, { namespace: string; key?: string; expiresAt: number }>();
const DELETE_TOKEN_TTL_MS = 60_000; // 1 minute

function generateDeleteToken(namespace: string, key?: string): string {
  const token = randomBytes(16).toString("hex");
  deleteTokens.set(token, {
    namespace,
    key,
    expiresAt: Date.now() + DELETE_TOKEN_TTL_MS,
  });
  return token;
}

function consumeDeleteToken(token: string, namespace: string, key?: string): boolean {
  const entry = deleteTokens.get(token);
  if (!entry) return false;
  deleteTokens.delete(token);

  if (entry.expiresAt < Date.now()) return false;
  if (entry.namespace !== namespace) return false;
  if (entry.key !== key) return false;
  return true;
}

// Clean expired tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of deleteTokens) {
    if (entry.expiresAt < now) deleteTokens.delete(token);
  }
}, 30_000);

function parseEntry(entry: Entry) {
  return {
    ...entry,
    tags: JSON.parse(entry.tags) as string[],
  };
}

function contentPreview(content: string, maxLen = 500): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen) + "...";
}

const STALENESS_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function isStale(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() > STALENESS_THRESHOLD_MS;
}

/**
 * Auto-add a new projects/* namespace to the workbench's "Needs Review" section.
 * Only called when the first entry in a projects/* namespace is created.
 * Returns true if the workbench was actually updated, false otherwise.
 */
function autoAddToWorkbench(db: Database.Database, namespace: string): boolean {
  const workbench = readState(db, "meta", "workbench");
  if (!workbench) return false;

  const content = workbench.content;
  const needsReviewHeader = "## Needs Review";
  const idx = content.indexOf(needsReviewHeader);
  if (idx === -1) return false;

  const line = `\n- ${namespace} — auto-added, not yet reviewed`;

  // Find the end of the "Needs Review" section (next ## or end of content)
  const afterHeader = idx + needsReviewHeader.length;
  const nextSection = content.indexOf("\n##", afterHeader);
  const insertAt = nextSection !== -1 ? nextSection : content.length;

  const updated = content.slice(0, insertAt) + line + content.slice(insertAt);
  writeState(db, "meta", "workbench", updated, JSON.parse(workbench.tags) as string[]);
  return true;
}

const TOOL_DEFINITIONS = [
  {
    name: "memory_orient",
    description:
      "START HERE. Call this at the beginning of every conversation before using any other memory tool. Returns the usage conventions (how to use this memory system), the active project dashboard, and a namespace overview — everything needed to orient yourself in one call.\n\nIf you are unsure how to use memory_write, memory_read, memory_log, or any other memory tool, the conventions returned by this tool contain the full guide.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "memory_write",
    description:
      "Store or update a state entry in memory. If an entry with the same namespace+key exists, it will be overwritten. Use this for mutable facts: project status, current decisions, known preferences.\n\nIf this is your first memory operation in this conversation, call memory_orient first.\n\nNamespace conventions: projects/<name> for project state (key 'status' for summary, other keys for aspects), people/<name> for context about people, decisions/<topic> for cross-cutting decisions, meta/workbench for cross-project dashboard.\n\nTo start a new project: (1) write projects/<name>/status with scope, decisions, and next steps, (2) update meta/workbench to list it as active.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description:
            "Hierarchical namespace using / separator. E.g. 'projects/hugin-munin', 'people/magnus', 'decisions/tech-stack'",
        },
        key: {
          type: "string",
          description:
            "Short descriptive slug for this entry. E.g. 'status', 'architecture', 'preferences'",
        },
        content: {
          type: "string",
          description:
            "The content to store. Markdown supported. Be specific and write for your future self.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            'Optional freeform tags for cross-cutting queries. Must be a JSON array, e.g. ["decision", "raspberry-pi", "active"]. Do NOT pass as a comma-separated string.',
        },
      },
      required: ["namespace", "key", "content"],
    },
  },
  {
    name: "memory_read",
    description:
      "Retrieve a specific state entry by namespace and key. Returns the full content, tags, and timestamps. Returns a clear 'not found' message if the entry doesn't exist (not an error).\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description: "The namespace to read from",
        },
        key: {
          type: "string",
          description: "The key of the state entry to read",
        },
      },
      required: ["namespace", "key"],
    },
  },
  {
    name: "memory_read_batch",
    description:
      "Retrieve multiple state entries in a single call. Returns an array of results (found or not found) in the same order as the input. Use this to orient on multiple projects at once instead of making sequential memory_read calls.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reads: {
          type: "array",
          items: {
            type: "object",
            properties: {
              namespace: { type: "string", description: "The namespace to read from" },
              key: { type: "string", description: "The key of the state entry to read" },
            },
            required: ["namespace", "key"],
          },
          description: 'Array of {namespace, key} pairs to read. E.g. [{"namespace": "projects/foo", "key": "status"}, {"namespace": "projects/bar", "key": "status"}]',
        },
      },
      required: ["reads"],
    },
  },
  {
    name: "memory_get",
    description:
      "Retrieve a single memory entry by its ID. Returns the full content regardless of entry type (state or log). Use this when memory_query returns a relevant result and you need the complete content.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The UUID of the entry to retrieve",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_query",
    description:
      "Search across memories. Supports lexical (FTS5 keyword), semantic (vector similarity), and hybrid (RRF fusion of both) search modes. Filters by namespace prefix, entry type, and tags.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Search terms. For lexical mode, FTS5 syntax supported. For semantic/hybrid, natural language works best.",
        },
        namespace: {
          type: "string",
          description:
            "Optional. Filter to a namespace or namespace prefix (e.g. 'projects/' matches all project namespaces)",
        },
        entry_type: {
          type: "string",
          enum: ["state", "log"],
          description: "Optional. Filter by entry type.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            'Optional. Filter to entries that have ALL of these tags. Must be a JSON array, e.g. ["decision", "active"].',
        },
        limit: {
          type: "number",
          description: "Max results to return. Default 10, max 50.",
        },
        search_mode: {
          type: "string",
          enum: ["lexical", "semantic", "hybrid"],
          description:
            "Search mode. Default: hybrid (RRF fusion of keyword + vector). Lexical: FTS5 keyword search. Semantic: vector KNN similarity. Degrades to lexical if embeddings unavailable.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_log",
    description:
      "Append a chronological log entry. Log entries are immutable and timestamped. Use this for recording decisions (always include rationale), milestones, discoveries, and events worth preserving. Pair with memory_write: state entries hold current truth, log entries hold the history of how you got there.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description: "The namespace to log to",
        },
        content: {
          type: "string",
          description:
            "The log entry content. Be specific — include what was decided and why.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: 'Optional tags. Must be a JSON array, e.g. ["decision", "active"].',
        },
      },
      required: ["namespace", "content"],
    },
  },
  {
    name: "memory_list",
    description:
      "Browse memory contents. Without a namespace: shows all namespaces with entry counts and last_activity_at. With a namespace: shows all state keys and log count in that namespace. Use without namespace to get a full inventory of what's stored.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description:
            "Optional. If provided, list contents of this namespace. If omitted, list all namespaces.",
        },
      },
      required: [],
    },
  },
  {
    name: "memory_delete",
    description:
      "Delete a specific state entry by namespace+key, or all entries in a namespace. First call without delete_token to preview what will be deleted. Then call with the returned delete_token to execute.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description: "The namespace to delete from",
        },
        key: {
          type: "string",
          description:
            "Optional. If provided, delete only this state entry. If omitted, delete ALL entries (state and log) in the namespace.",
        },
        delete_token: {
          type: "string",
          description:
            "The token returned from a preview call. Required to execute the delete.",
        },
      },
      required: ["namespace"],
    },
  },
];

export function getMaxContentSize(): number {
  const envVal = process.env.MUNIN_MEMORY_MAX_CONTENT_SIZE;
  return envVal ? parseInt(envVal, 10) || 100_000 : 100_000;
}

export function registerTools(server: Server, db: Database.Database): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;
      const maxContentSize = getMaxContentSize();

      try {
        switch (name) {
          case "memory_orient": {
            // Read conventions, workbench, and namespace list in one call
            const conventions = readState(db, "meta/conventions", "conventions");
            const workbench = readState(db, "meta", "workbench");
            const namespaces = listNamespaces(db);

            const response: Record<string, unknown> = {};

            if (conventions) {
              const parsed = parseEntry(conventions);
              const conv: Record<string, unknown> = {
                content: parsed.content,
                updated_at: parsed.updated_at,
              };
              if (isStale(parsed.updated_at)) conv.stale = true;
              response.conventions = conv;
            } else {
              response.conventions = {
                content: null,
                message: "No conventions found. Write to meta/conventions with key 'conventions' to set them up.",
              };
            }

            if (workbench) {
              const parsed = parseEntry(workbench);
              const wb: Record<string, unknown> = {
                content: parsed.content,
                updated_at: parsed.updated_at,
              };
              if (isStale(parsed.updated_at)) wb.stale = true;
              response.workbench = wb;
            } else {
              response.workbench = {
                content: null,
                message: "No workbench found. Write to meta with key 'workbench' to set it up.",
              };
            }

            response.namespaces = namespaces;

            return {
              content: [{
                type: "text",
                text: JSON.stringify(response),
              }],
            };
          }

          case "memory_write": {
            const { namespace, key, content, tags } = args as unknown as WriteParams;
            const validation = validateWriteInput(namespace, key, content, tags, maxContentSize);
            if (!validation.valid) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: validation.error }) }] };
            }
            const result = writeState(db, namespace, key, content, tags ?? []);
            const otherKeys = getOtherKeysInNamespace(db, namespace, key);
            const isFirstEntry = otherKeys.length === 0;
            const hint = isFirstEntry
              ? "This is the first entry in this namespace."
              : `Related entries in this namespace: ${otherKeys.join(", ")}`;

            // Auto-add new projects/* namespaces to workbench
            let workbenchUpdated = false;
            if (result.status === "created" && isFirstEntry && namespace.startsWith("projects/")) {
              try {
                workbenchUpdated = autoAddToWorkbench(db, namespace);
              } catch {
                // Non-critical — don't fail the write
              }
            }

            const response: Record<string, unknown> = { ...result, namespace, key, hint };
            if (workbenchUpdated) {
              response.workbench_updated = true;
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response),
              }],
            };
          }

          case "memory_read": {
            const { namespace, key } = args as unknown as ReadParams;
            const nsCheck = validateNamespace(namespace);
            if (!nsCheck.valid) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: nsCheck.error }) }] };
            }
            const keyCheck = validateKey(key);
            if (!keyCheck.valid) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: keyCheck.error }) }] };
            }
            const entry = readState(db, namespace, key);
            if (entry) {
              const parsed = parseEntry(entry);
              const response: Record<string, unknown> = {
                found: true,
                id: parsed.id,
                namespace: parsed.namespace,
                key: parsed.key,
                content: parsed.content,
                tags: parsed.tags,
                created_at: parsed.created_at,
                updated_at: parsed.updated_at,
              };
              if (isStale(parsed.updated_at)) {
                response.stale = true;
              }
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify(response),
                }],
              };
            }
            const otherKeys = getOtherKeysInNamespace(db, namespace);
            const hint = otherKeys.length > 0
              ? `Other keys in this namespace: ${otherKeys.join(", ")}`
              : `No entries found in namespace "${namespace}".`;
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  found: false,
                  namespace,
                  key,
                  message: `No state entry found in namespace "${namespace}" with key "${key}".`,
                  hint,
                }),
              }],
            };
          }

          case "memory_read_batch": {
            const { reads } = args as unknown as ReadBatchParams;
            if (!Array.isArray(reads) || reads.length === 0) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: "reads must be a non-empty array of {namespace, key} pairs." }) }] };
            }
            if (reads.length > 20) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: "Maximum 20 reads per batch." }) }] };
            }

            const results = reads.map(({ namespace: ns, key: k }) => {
              const nsCheck = validateNamespace(ns);
              if (!nsCheck.valid) return { found: false, namespace: ns, key: k, error: nsCheck.error };
              const keyCheck = validateKey(k);
              if (!keyCheck.valid) return { found: false, namespace: ns, key: k, error: keyCheck.error };

              const entry = readState(db, ns, k);
              if (entry) {
                const parsed = parseEntry(entry);
                const result: Record<string, unknown> = {
                  found: true,
                  id: parsed.id,
                  namespace: parsed.namespace,
                  key: parsed.key,
                  content: parsed.content,
                  tags: parsed.tags,
                  created_at: parsed.created_at,
                  updated_at: parsed.updated_at,
                };
                if (isStale(parsed.updated_at)) {
                  result.stale = true;
                }
                return result;
              }
              return { found: false, namespace: ns, key: k };
            });

            return {
              content: [{
                type: "text",
                text: JSON.stringify({ results }),
              }],
            };
          }

          case "memory_get": {
            const { id } = args as unknown as GetParams;
            if (!id || typeof id !== "string") {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: "ID is required." }) }] };
            }
            const entry = getById(db, id);
            if (entry) {
              const parsed = parseEntry(entry);
              const response: Record<string, unknown> = {
                found: true,
                id: parsed.id,
                namespace: parsed.namespace,
                key: parsed.key,
                entry_type: parsed.entry_type,
                content: parsed.content,
                tags: parsed.tags,
                created_at: parsed.created_at,
                updated_at: parsed.updated_at,
              };
              if (isStale(parsed.updated_at)) {
                response.stale = true;
              }
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify(response),
                }],
              };
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  found: false,
                  message: `No entry found with ID "${id}".`,
                }),
              }],
            };
          }

          case "memory_query": {
            const { query, namespace, entry_type, tags, limit, search_mode } =
              args as unknown as QueryParams;
            if (!query || typeof query !== "string") {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: "Query string is required." }) }] };
            }

            const requestedMode: SearchMode = search_mode ?? "hybrid";
            let actualMode: SearchMode = requestedMode;
            let warning: string | undefined;
            let results: Entry[];

            if (requestedMode === "semantic") {
              if (!isSemanticEnabled() || !vecLoaded()) {
                actualMode = "lexical";
                warning = `Semantic search unavailable (${getEmbeddingStatusReason()}). Falling back to lexical search.`;
              }
            } else if (requestedMode === "hybrid") {
              if (!isHybridEnabled() || !vecLoaded()) {
                actualMode = "lexical";
                warning = `Hybrid search unavailable (${getEmbeddingStatusReason()}). Falling back to lexical search.`;
              }
            }

            if (actualMode === "semantic") {
              const queryEmb = await generateEmbedding(query);
              if (!queryEmb) {
                actualMode = "lexical";
                warning = "Failed to generate query embedding. Falling back to lexical search.";
              } else {
                const buf = embeddingToBuffer(queryEmb);
                results = queryEntriesSemantic(db, {
                  queryEmbedding: buf,
                  namespace,
                  entryType: entry_type,
                  tags,
                  limit,
                });
              }
            }

            if (actualMode === "hybrid") {
              const queryEmb = await generateEmbedding(query);
              if (!queryEmb) {
                actualMode = "lexical";
                warning = "Failed to generate query embedding. Falling back to lexical search.";
              } else {
                const buf = embeddingToBuffer(queryEmb);
                results = queryEntriesHybrid(db, {
                  ftsOptions: { query, namespace, entryType: entry_type, tags, limit },
                  semanticOptions: { queryEmbedding: buf, namespace, entryType: entry_type, tags, limit },
                });
              }
            }

            // Lexical fallback (or original mode)
            if (actualMode === "lexical") {
              results = queryEntries(db, {
                query,
                namespace,
                entryType: entry_type,
                tags,
                limit,
              });
            }

            const formatted = results!.map((entry) => ({
              id: entry.id,
              namespace: entry.namespace,
              key: entry.key,
              entry_type: entry.entry_type,
              content_preview: contentPreview(entry.content),
              tags: JSON.parse(entry.tags) as string[],
              created_at: entry.created_at,
              updated_at: entry.updated_at,
            }));

            const response: Record<string, unknown> = {
              results: formatted,
              total: formatted.length,
              query,
              search_mode: requestedMode,
            };
            if (actualMode !== requestedMode) {
              response.search_mode_actual = actualMode;
            }
            if (warning) {
              response.warning = warning;
            }

            return {
              content: [{
                type: "text",
                text: JSON.stringify(response),
              }],
            };
          }

          case "memory_log": {
            const { namespace, content, tags } = args as unknown as LogParams;
            const validation = validateLogInput(namespace, content, tags, maxContentSize);
            if (!validation.valid) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: validation.error }) }] };
            }
            const result = appendLog(db, namespace, content, tags ?? []);
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  status: "logged",
                  id: result.id,
                  namespace,
                  timestamp: result.timestamp,
                }),
              }],
            };
          }

          case "memory_list": {
            const { namespace } = (args ?? {}) as ListParams;
            if (!namespace) {
              const namespaces = listNamespaces(db);
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({ namespaces }),
                }],
              };
            }
            const nsCheck = validateNamespace(namespace);
            if (!nsCheck.valid) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: nsCheck.error }) }] };
            }
            const { stateEntries, logSummary } = listNamespaceContents(db, namespace);
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  namespace,
                  state_entries: stateEntries.map((e) => ({
                    key: e.key,
                    preview: e.preview,
                    tags: JSON.parse(e.tags) as string[],
                    updated_at: e.updated_at,
                  })),
                  log_summary: logSummary,
                }),
              }],
            };
          }

          case "memory_delete": {
            const { namespace, key, delete_token } =
              args as unknown as DeleteParams;
            const nsCheck = validateNamespace(namespace);
            if (!nsCheck.valid) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: nsCheck.error }) }] };
            }
            if (key) {
              const keyCheck = validateKey(key);
              if (!keyCheck.valid) {
                return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: keyCheck.error }) }] };
              }
            }

            // Execute with token
            if (delete_token) {
              if (!consumeDeleteToken(delete_token, namespace, key)) {
                return {
                  content: [{
                    type: "text",
                    text: JSON.stringify({
                      error: "invalid_token",
                      message: "Delete token is invalid, expired, or doesn't match the requested namespace/key. Request a new preview first.",
                    }),
                  }],
                };
              }
              const deletedCount = executeDelete(db, namespace, key);
              const target = key ? `entry "${key}" in "${namespace}"` : `all entries in "${namespace}"`;
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    action: "deleted",
                    namespace,
                    key: key ?? undefined,
                    deleted_count: deletedCount,
                    message: `Deleted ${deletedCount} entries (${target}).`,
                  }),
                }],
              };
            }

            // Preview
            const info = previewDelete(db, namespace, key);
            const token = generateDeleteToken(namespace, key);
            const target = key ? `entry "${key}" in "${namespace}"` : `all entries in "${namespace}"`;
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  action: "preview",
                  namespace,
                  key: key ?? undefined,
                  will_delete: {
                    state_count: info.stateCount,
                    log_count: info.logCount,
                    keys: info.keys.length > 0 ? info.keys : undefined,
                  },
                  delete_token: token,
                  message: `Will delete ${info.stateCount} state entries and ${info.logCount} log entries (${target}). Call again with delete_token to confirm.`,
                }),
              }],
            };
          }

          default:
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  error: "unknown_tool",
                  message: `Unknown tool: ${name}`,
                }),
              }],
            };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: "internal_error", message }),
          }],
          isError: true,
        };
      }
    },
  );
}
