# The Librarian — Data Classification & Transport-Aware Access Control

**Version:** 0.2 (Post-debate revision)
**Date:** 2026-04-02
**Author:** Magnus Gille + Claude (Opus 4.6)
**Reviewed by:** Codex (GPT-5.4) — adversarial review, 2 rounds, 15 critique points
**Status:** Architecture approved — ready for implementation planning
**Engineering plan:** `docs/librarian-engineering-plan.md`
**Depends on:** Multi-principal access control (Feature 5, implemented)
**Debate record:** `debate/librarian-summary.md`

---

## 1. Problem Statement

Munin Memory is accessible from multiple AI platforms with different legal terms governing data handling:

| Environment | Auth method | Anthropic's role | DPA | Training |
|---|---|---|---|---|
| **Claude Code** (API) | Legacy bearer | **Processor** | Yes | Never (contractual) |
| **Claude.ai** (web) | OAuth | **Controller** | No | Opt-out toggle |
| **Claude Desktop** | OAuth / mcp-remote | **Controller** | No | Opt-out toggle |
| **Claude Mobile** | OAuth | **Controller** | No | Opt-out toggle |
| **Codex CLI** (OpenAI) | Agent token | Processor | Yes (Teams) | Never (Teams) |

When Munin returns content to an AI platform, that content enters the platform's conversation context and is governed by that platform's legal terms. Under consumer terms (Claude.ai/Desktop/Mobile), Anthropic acts as **data controller** with no DPA, no contractual training prohibition, and no Art. 28 processor obligations.

**The problem:** Client data (names, contact details, meeting notes, proposals) stored in Munin should not flow through platforms where the AI provider acts as data controller without a DPA. This is a GDPR compliance requirement, not merely a preference.

**Current mitigation:** OAuth MCP connectors are disabled on consumer platforms. This works but eliminates all mobile/web access to Munin, including benign uses like checking project status or personal notes.

**Goal:** Re-enable consumer platform access with data-classification-aware gating — public and internal data flows freely; client data is blocked at the Munin boundary.

---

## 2. Threat Model

### 2.1 What we are protecting against

| Threat | Description | Severity |
|---|---|---|
| **T1: Client PII in consumer context** | Client names, emails, phone numbers sent to Anthropic under controller terms | High — GDPR Art. 28 violation |
| **T2: Confidential business data in consumer context** | Meeting notes, proposals, project details sent without DPA | Medium — contractual/reputational |
| **T3: Restricted data in any cloud context** | Data marked restricted by client contract sent to any cloud AI | High — contractual breach |
| **T4: Classification bypass** | Attacker or bug causes classified content to bypass gating | High — renders the system useless |
| **T5: Classification downgrade** | Non-owner modifies classification tags to lower a level | Medium — integrity violation |
| **T6: Metadata leakage** | Entry existence, tags, or timestamps reveal protected information | Low — acceptable trade-off (see §5.3) |
| **T7: Content reconstruction** | Combining metadata from redacted entries with visible entries to infer classified content | Low — inherent in any metadata-visible system |

### 2.2 What we are NOT protecting against

| Non-threat | Rationale |
|---|---|
| **User copy-paste** | Magnus can always type or paste client data into any Claude session manually. The Librarian prevents *systematic* data flow, not intentional user action. |
| **Model memorization** | If data was previously sent through a DPA-covered session, residual knowledge in model weights is governed by the provider's terms, not Munin's gating. |
| **Munin server compromise** | The Librarian is an application-layer control. Server compromise is addressed by the existing 5-layer security model. |
| **Anthropic terms change** | If Anthropic changes API terms to remove DPA, the transport classification configuration must be updated. The Librarian doesn't monitor terms. |

### 2.3 Attack surface

| Vector | Mitigation |
|---|---|
| Strip classification tag from entry | Dedicated DB column (not just a tag); tag is denormalized convenience |
| Modify classification column directly (SQL) | Only possible with DB file access (Pi hardening prevents) |
| Write entry with lower-than-allowed classification | Write-time validation enforces namespace minimum |
| Query crafting to extract classified content via search snippets | Classification filter runs post-query; no snippets for redacted entries |
| Embedding similarity leakage | Classification filter runs after vector search; no scores exposed for redacted entries |
| OAuth client impersonation | Existing OAuth security (PKCE, token rotation, CF Access) prevents |
| Agent token reuse from consumer platform | Agent tokens are per-principal; transport type is per-auth-method |
| DPA-covered credential used from consumer platform | Dedicated credential per transport class; consumer clients never receive DPA credential (§5.2) |
| Derived tool leaks classified content via synthesis | Pre-synthesis source filtering excludes classified entries before any content mixing (§7.6) |
| Redacted metadata reveals protected relationships | Tiered metadata policy: owner gets full metadata, non-owner gets minimal (§6.2) |
| Namespace floor table lowered by compromised admin | Owner-only mutation, audit-logged, startup validation (§4.3) |
| Reclassified source entry still copied in derivative tables | Derivative data lifecycle rules: reclassification triggers scrub/recompute (§7.7) |

---

## 3. Design Principles

1. **Two orthogonal dimensions.** Principal access control (WHO can see WHICH namespaces) and classification control (WHAT data can flow through WHICH connection) are independent systems that compose. Neither subsumes the other.

2. **Fail-closed at every layer.** Unknown classification → treated as `client-restricted`. Unknown transport → treated as `consumer`. Missing column → treated as `client-restricted`. Parse error → `client-restricted`.

3. **Classification gates reads, not writes.** The data protection concern is content flowing FROM Munin TO the AI platform (reads). Content flowing FROM the user TO Munin (writes) is the safe direction. Write responses don't include prior content.

4. **Redaction is visible, not invisible.** Unlike namespace access control (where denied entries are invisible), classification redaction is explicit. The user should know relevant data exists and how to access it through a compliant channel. This is a deliberate UX and compliance decision.

5. **Defense in depth.** Classification enforcement exists at multiple points: DB column with CHECK constraint, write-time validation, read-time filtering, and audit logging. No single failure bypasses all layers.

6. **Auditable.** Every redaction event is logged with full context (who, what, when, why). This creates the compliance evidence trail that GDPR requires.

7. **Namespace defaults as safety net.** Every namespace has a minimum classification floor. Entries can be classified higher, never lower (without explicit owner override). This prevents accidental exposure of client data.

---

## 4. Classification Model

### 4.1 Classification levels

Four levels, strictly ordered:

| Level | Rank | Tag | Description |
|---|---|---|---|
| `public` | 0 | `classification:public` | Publicly available information. No restrictions. |
| `internal` | 1 | `classification:internal` | Magnus's own work. No client PII. Safe for any interactive AI session. |
| `client-confidential` | 2 | `classification:client-confidential` | Contains client PII or business context. Requires DPA-covered AI platform. |
| `client-restricted` | 3 | `classification:client-restricted` | Contractually restricted. No cloud AI under any terms. Local processing only. |

### 4.2 Storage

**Primary:** Dedicated `classification` column on the `entries` table:

```sql
ALTER TABLE entries ADD COLUMN classification TEXT NOT NULL DEFAULT 'internal'
  CHECK(classification IN ('public', 'internal', 'client-confidential', 'client-restricted'));
```

**Secondary (denormalized):** The `classification:*` tag is maintained in the `tags` JSON array for discoverability. Tools can read classification from either source; the column is authoritative.

**Consistency invariant:** The column value and the `classification:*` tag (if present) must agree. `memory_write` enforces this on every write. A startup consistency check flags mismatches.

### 4.3 Namespace classification floors

Every namespace has a minimum classification floor. Entries inherit this floor unless explicitly classified higher.

**Storage:** Namespace floors are stored in the database, not hard-coded in application logic. This prevents policy drift when new namespaces are created — floors can be updated via `munin-admin` without a code deploy.

```sql
CREATE TABLE namespace_classification (
  namespace_pattern TEXT PRIMARY KEY,  -- "clients/*", "people/*", etc.
  min_classification TEXT NOT NULL
    CHECK(min_classification IN ('public', 'internal', 'client-confidential', 'client-restricted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Seed values (loaded on first migration):**

| Namespace pattern | Default | Rationale |
|---|---|---|
| `clients/*` | `client-confidential` | Client engagement data, contact PII |
| `people/*` | `client-confidential` | Contact details, relationship context |
| `business/*` | `client-confidential` | Financial and business data |
| `projects/*` | `internal` | Own project work (may contain client refs — classify individually) |
| `decisions/*` | `internal` | Cross-cutting decisions |
| `meta/*` | `internal` | System configuration and conventions |
| `documents/*` | `internal` | Indexed artifacts (override per-doc) |
| `users/*` | `internal` | Personal user data |
| `shared/*` | `internal` | Shared spaces |
| `signals/*` | `internal` | Ingested signals |
| `digests/*` | `internal` | Compiled digests |
| `tasks/*` | `internal` | Task queue |
| `briefings/*` | `internal` | Generated briefings |
| `rituals/*` | `internal` | Ritual/routine config |
| `reading/*` | `public` | Reading queue (public content) |
| `demo/*` | `public` | Demo/example data |

**Resolution:** Longest matching prefix wins. If no prefix matches, the global default applies (`MUNIN_CLASSIFICATION_DEFAULT`, default: `internal`).

**Management via munin-admin:**
```bash
npx munin-admin classification set-floor "clients/*" client-confidential
npx munin-admin classification set-floor "contracts/*" client-restricted
npx munin-admin classification list-floors
npx munin-admin classification audit  # Show entries below their namespace floor
```

**Security properties of the floor table:**
- **Owner-only mutation.** Only owner principals can modify namespace floors (enforced in `munin-admin`).
- **Audit-logged.** Every floor change is recorded in `audit_log` with before/after values.
- **Startup validation.** On server start, check for: overlapping patterns with conflicting floors, missing floors for tracked namespaces (`projects/*`, `clients/*`), and entries classified below their namespace floor.
- **Deterministic precedence.** Longest prefix match wins. If two patterns match the same namespace at the same length, the higher classification takes precedence (fail-closed).

### 4.4 Write-time classification enforcement

When `memory_write` or `memory_log` stores an entry:

1. **Resolve explicit classification:** Check for `classification:*` tag in the provided tags array, or a `classification` parameter (if added to the tool schema).
2. **Resolve namespace minimum:** Look up the namespace default from §4.3.
3. **Apply rules:**
   - If explicit classification provided AND >= namespace minimum → use explicit
   - If explicit classification provided AND < namespace minimum → **reject** unless caller is owner AND passes `classification_override: true`
   - If no explicit classification → use namespace minimum
4. **Store:** Set the `classification` column. Add/update the `classification:*` tag in the tags array.
5. **Audit:** If `classification_override` was used, log to `audit_log`.

**Rationale for rejecting below-minimum:** An entry in `clients/lofalk` should never be classified as `public`. The namespace exists because the data is client-related. Allowing lower-than-namespace classification creates a trivial bypass.

---

## 5. Transport Context Model

### 5.1 Transport types

Each connection to Munin has a transport type determined at auth time:

| Transport type | Description | Max classification |
|---|---|---|
| `local` | stdio connection. Data never leaves the machine. | `client-restricted` (all) |
| `dpa_covered` | HTTP with DPA-covered AI platform (Claude Code API, Codex Teams). | `client-confidential` |
| `consumer` | HTTP with consumer AI platform (Claude.ai, Desktop, Mobile). No DPA. | `internal` |

### 5.2 Transport resolution — credential-based attestation

Transport type is determined by **which credential** the caller presents. Credential provisioning is the trust anchor — the DPA-covered credential must never be distributed to consumer clients.

**Dedicated credentials per transport class:**

| Credential | Env var | Transport type | Distributed to |
|---|---|---|---|
| DPA bearer token | `MUNIN_API_KEY_DPA` | `dpa_covered` | Claude Code only (commercial API terms, DPA) |
| Consumer bearer token | `MUNIN_API_KEY_CONSUMER` | `consumer` | mcp-remote on Desktop, any future consumer bearer client |
| OAuth token | (issued per-client) | `consumer` | Claude.ai, Claude Mobile |
| Agent service token | (per-principal) | Per-principal config | Agents (Skuld, Hugin, etc.) |

**Resolution rules:**

| Auth method | Transport type | Mechanism |
|---|---|---|
| **stdio** | `local` | Direct local connection. No cloud transfer. Hardcoded — cannot be overridden. |
| **Bearer matching `MUNIN_API_KEY_DPA`** | `dpa_covered` | Token proves the caller was provisioned for DPA-covered access. |
| **Bearer matching `MUNIN_API_KEY_CONSUMER`** | `consumer` | Token proves the caller was provisioned for consumer access. |
| **Bearer matching legacy `MUNIN_API_KEY`** | Configurable via `MUNIN_BEARER_TRANSPORT_TYPE` | Backward compatibility. Default: `dpa_covered`. Logged with deprecation warning. |
| **OAuth token** | `consumer` | All OAuth clients assumed consumer until per-client transport is supported. |
| **Agent service token** | Per-principal config | Read `transport_type` from `principals` table. |

**Hard rule: HTTP can never be `local`.** Regardless of any configuration or admin setting, only stdio connections are classified as `local`. If an HTTP-authenticated principal has `transport_type: "local"` in the database, it is downgraded to `dpa_covered` at resolution time. This ensures `client-restricted` entries are ONLY accessible via stdio.

```typescript
// Enforced in resolveAccessContext, not configurable
if (transportType === "local" && authMethod !== "stdio") {
  transportType = "dpa_covered"; // Downgrade: HTTP cannot be local
}
```

**Migration path from single bearer token:**
1. Generate `MUNIN_API_KEY_DPA` and `MUNIN_API_KEY_CONSUMER` (separate values)
2. Configure Claude Code with `MUNIN_API_KEY_DPA`
3. If re-enabling Desktop mcp-remote, configure with `MUNIN_API_KEY_CONSUMER`
4. Keep `MUNIN_API_KEY` as fallback during transition (logged as deprecated)
5. Remove `MUNIN_API_KEY` after all clients are migrated

**Operational implication:** Credential provisioning IS the security control. Distributing `MUNIN_API_KEY_DPA` to a consumer client is a security incident, not a configuration error. The server cannot detect this — it trusts the credential. The audit trail (which credential was used, from which IP, at which time) provides forensic evidence if provisioning is compromised.

### 5.3 Effective classification ceiling

The effective maximum classification for a connection is the minimum of:

```
effectiveMax = min(transport.maxClassification, principal.maxClassification)
```

Where `principal.maxClassification` is stored in the `principals` table (new column) with type-based defaults:

| Principal type | Default max | Rationale |
|---|---|---|
| `owner` | `client-restricted` | No ceiling. Owner sees everything through any sufficiently privileged transport. |
| `family` | `internal` | Family members don't need client data. Defense-in-depth alongside namespace rules. |
| `agent` | `internal` | Agents get the minimum needed. Escalate per-agent. |
| `external` | `public` | External principals see only public data within their namespace scope. |

**Override:** The `max_classification` column in `principals` can be set higher than the type default by an admin (via `munin-admin`). E.g., a family member involved in the business could be given `client-confidential`. The transport ceiling still applies — `min()` is always enforced.

### 5.4 Extended AccessContext

The `AccessContext` type gains two fields:

```typescript
export type ClassificationLevel =
  | "public"
  | "internal"
  | "client-confidential"
  | "client-restricted";

export type TransportType = "local" | "dpa_covered" | "consumer";

export interface AccessContext {
  // Existing (Feature 5)
  principalId: string;
  principalType: PrincipalType;
  accessibleNamespaces: NamespaceRule[];

  // Librarian (Feature 6)
  maxClassification: ClassificationLevel;
  transportType: TransportType;
}
```

**Resolution in `resolveAccessContext`:**

```
1. Resolve principal (existing logic) → principalId, principalType, accessibleNamespaces
2. Determine transport type from auth method
3. Read principal.max_classification (or use type default)
4. Compute effectiveMax = min(transport max, principal max)
5. Return AccessContext with all fields
```

**Fail-closed:** If transport type cannot be determined → `consumer`. If principal max_classification is NULL or unparseable → type default. If type default is somehow missing → `public` (most restrictive for non-owner). For owner, fail-closed means `internal` (not `client-restricted`), ensuring the system errs on the side of caution even for the owner.

---

## 6. Enforcement Architecture

### 6.1 Three-layer filtering pipeline

Every tool that returns entry content applies three filters in order:

```
Raw DB results
    │
    ▼
┌─────────────────────────────────┐
│  Layer 1: Principal Access      │  ← Existing (Feature 5)
│  canRead(ctx, namespace)        │
│                                 │
│  Denied → INVISIBLE             │
│  ("not found" / omitted)        │
└─────────────┬───────────────────┘
              │ Entries the principal CAN access
              ▼
┌─────────────────────────────────┐
│  Layer 2: Classification Gate   │  ← NEW (Librarian)
│  classificationAllowed(         │
│    entry.classification,        │
│    ctx.maxClassification        │
│  )                              │
│                                 │
│  Denied → REDACTED              │
│  (metadata only + reason)       │
└─────────────┬───────────────────┘
              │ Entries allowed through
              ▼
┌─────────────────────────────────┐
│  Layer 3: Response Formatting   │
│                                 │
│  Full content for allowed       │
│  Metadata + notice for redacted │
└─────────────────────────────────┘
```

**Key distinction:**
- Layer 1 (access): Denied entries are **invisible**. The caller cannot distinguish "doesn't exist" from "access denied."
- Layer 2 (classification): Denied entries are **redacted**. The caller sees metadata + a notice explaining why and how to access the full content.

This distinction is deliberate:
- **Namespace isolation** is a security boundary (Sara shouldn't know `projects/foo` exists).
- **Classification gating** is a legal/compliance boundary (Magnus knows his own data exists — he just can't surface it through this AI platform).

### 6.2 Redacted entry format — tiered metadata policy

Redaction metadata differs by principal type. This prevents non-owner principals from learning protected relationships (e.g., that a specific company is an active client) through redacted entry metadata.

**Owner on downgraded transport** (e.g., Magnus via Claude.ai):

Full metadata — the owner already knows their own data exists. The redaction notice guides them to the right environment.

```json
{
  "namespace": "clients/lofalk",
  "key": "status",
  "entry_type": "state",
  "classification": "client-confidential",
  "redacted": true,
  "redaction_reason": "This entry is classified as client-confidential. Your current connection (consumer, no DPA) allows up to internal. Access full content via Claude Code (API terms with DPA).",
  "tags": ["active", "client", "classification:client-confidential"],
  "created_at": "2026-03-01T10:00:00.000Z",
  "updated_at": "2026-03-15T14:30:00.000Z"
}
```

**Non-owner principal** (family, agent, external) — entry passes Layer 1 but fails Layer 2:

Minimal metadata — only namespace and reason. No key, tags, or timestamps. Prevents existence oracles for specific entries.

```json
{
  "namespace": "shared/family",
  "redacted": true,
  "redaction_reason": "Some entries in this namespace exceed your classification level."
}
```

**Summary of included fields:**

| Field | Owner (redacted) | Non-owner (redacted) |
|---|---|---|
| namespace | Yes | Yes |
| key | Yes | No |
| entry_type | Yes | No |
| classification | Yes | No |
| tags | Yes | No |
| created_at | Yes | No |
| updated_at | Yes | No |
| redacted | Yes | Yes |
| redaction_reason | Specific (per-entry) | Generic (per-namespace) |
| content | No | No |
| content_preview | No | No |
| FTS5 snippets | No | No |
| Ranking scores / explain fields | No | No |

**Excluded for ALL principals:** content, content_preview, FTS5 snippets, ranking scores, semantic distances, explain reasons, and any other derived content fields.

### 6.3 Classification comparison

```typescript
const CLASSIFICATION_RANK: Record<ClassificationLevel, number> = {
  "public": 0,
  "internal": 1,
  "client-confidential": 2,
  "client-restricted": 3,
};

export function classificationAllowed(
  entryClassification: ClassificationLevel,
  maxAllowed: ClassificationLevel,
): boolean {
  return CLASSIFICATION_RANK[entryClassification] <= CLASSIFICATION_RANK[maxAllowed];
}
```

### 6.4 Feature gate

The Librarian is controlled by a master switch:

| Env var | Default | Description |
|---|---|---|
| `MUNIN_LIBRARIAN_ENABLED` | `false` | Enable classification enforcement |

When disabled:
- Classification column still exists and is populated on writes
- No read-time filtering or redaction
- No redaction audit logging
- Transport context still resolved (for logging) but not enforced

This allows:
1. Deploy the migration and column backfill first
2. Run in observation mode (classifications visible in responses but not enforced)
3. Enable enforcement after verifying classifications are correct

---

## 7. Tool-by-Tool Enforcement

### 7.1 Tools that return entry content

These tools require classification filtering:

| Tool | Enforcement point | Redaction behavior |
|---|---|---|
| `memory_read` | After namespace access check, before returning content | Return redacted entry (metadata only) |
| `memory_read_batch` | Per-item, after access check | Per-item redaction |
| `memory_get` | After resolving entry's namespace + access check | Return redacted entry |
| `memory_query` | Post-query, after `filterByAccess` | Redacted entries included in results with `redacted: true` |
| `memory_orient` | Dashboard items, namespace overview | Dashboard items redacted; namespace counts adjusted |
| `memory_list` | Namespace entry listing | Entries redacted in listing; counts reflect redaction |
| `memory_attention` | Triage items | Redacted items included with notice |
| `memory_history` | Audit log entries | Content field redacted; action/namespace/timestamp visible |
| `memory_handoff` | Handoff summary content | Redacted sections noted |
| `memory_commitments` | Commitment content | Redacted entries noted |
| `memory_narrative` | Narrative content | Redacted entries noted |
| `memory_patterns` | Pattern analysis content | Redacted entries noted |
| `memory_resume` | Resume context | Redacted sections noted |

### 7.1.1 Two enforcement patterns

Content-returning tools fall into two categories requiring different enforcement:

**Pattern A: Direct entry tools** (`memory_read`, `memory_read_batch`, `memory_get`, `memory_query`, `memory_list`, `memory_history`). These return raw entries or entry metadata. Enforcement is post-query: filter or redact individual entries after DB access.

**Pattern B: Derived/synthesis tools** (`memory_orient`, `memory_resume`, `memory_handoff`, `memory_commitments`, `memory_narrative`, `memory_patterns`, `memory_attention`). These synthesize output from multiple source entries. **Enforcement must happen BEFORE synthesis** — you cannot redact a summary after classified content has already been mixed into it.

```typescript
/**
 * Pre-synthesis classification filter. Called by all Pattern B tools
 * BEFORE any content aggregation, summarization, or derivation.
 */
function filterSourcesByClassification<T extends { namespace: string; id: string }>(
  db: Database.Database,
  sources: T[],
  ctx: AccessContext,
  toolName: string,
): { allowed: T[]; redactedSources: RedactedSourceSummary[] } {
  const allowed: T[] = [];
  const redactedSources: RedactedSourceSummary[] = [];

  for (const source of sources) {
    const classification = getEntryClassification(db, source.id);
    if (classificationAllowed(classification, ctx.maxClassification)) {
      allowed.push(source);
    } else {
      redactedSources.push(
        formatRedactedSource(source, classification, ctx, toolName)
      );
      logRedaction(db, ctx, source, classification, toolName);
    }
  }

  return { allowed, redactedSources };
}
```

**Every Pattern B tool calls `filterSourcesByClassification` before processing.** The synthesis operates only on `allowed` sources. The response includes a `redacted_sources` summary so the caller knows content was excluded.

**`redacted_sources` metadata policy** (same tiering as §6.2):
- **Owner:** `{ count: N, namespaces: ["clients/lofalk", "people/contact"], reason: "..." }`
- **Non-owner:** `{ count: N, reason: "Some sources exceeded your classification level." }` — no namespace or entry details.

**Partial-failure rule for derived tools:** If any source entry has NULL or unparseable classification, that source is excluded (treated as `client-restricted`). The tool returns partial output from classifiable sources plus the `redacted_sources` summary. The tool does NOT fail entirely — partial output is more useful than no output. The redacted_sources field makes the omission visible.

### 7.1.2 Centralized enforcement wrapper

To prevent tool-by-tool enforcement gaps, classification enforcement uses a centralized wrapper:

```typescript
/**
 * Single enforcement function for Pattern A tools.
 * Handles: classification check, redaction formatting, audit logging.
 * Throws on NULL classification (fail-closed).
 */
function enforceClassification(
  db: Database.Database,
  entry: EntryRow,
  ctx: AccessContext,
  toolName: string,
): FullEntry | RedactedEntry {
  const classification = entry.classification;
  if (!classification || !isValidClassification(classification)) {
    // Fail-closed: unclassifiable entry treated as restricted
    logRedaction(db, ctx, entry, "client-restricted", toolName);
    return redactEntry(entry, ctx, "Entry has invalid or missing classification.");
  }
  if (!classificationAllowed(classification, ctx.maxClassification)) {
    logRedaction(db, ctx, entry, classification, toolName);
    return redactEntry(entry, ctx);
  }
  return entry; // Full content
}
```

**CI coverage test:** A test enumerates all registered MCP tool names and verifies each content-returning tool calls either `enforceClassification` (Pattern A) or `filterSourcesByClassification` (Pattern B). If a new tool is added without classification handling, CI fails. This converts "developer must remember" into "CI must pass."

### 7.2 Tools that don't return entry content

These tools need no classification enforcement:

| Tool | Reason |
|---|---|
| `memory_write` | Write direction (user → Munin). Classification set on write, not gated. |
| `memory_log` | Write direction. Classification set on write. |
| `memory_delete` | Destructive operation. Already gated by write access. Delete confirmation reveals only entry count, not content. |
| `memory_update_status` | Write operation. |
| `memory_insights` | Already owner-only. Owner always has max classification. |
| `memory_status` | System metrics, no entry content. |

### 7.3 Detailed: memory_read

```
memory_read(namespace, key)
  │
  ├─ canRead(ctx, namespace)?
  │   NO → { found: false }                          [INVISIBLE - access denied]
  │
  ├─ entry = readState(db, namespace, key)
  │   NULL → { found: false }                         [genuinely not found]
  │
  ├─ classificationAllowed(entry.classification, ctx.maxClassification)?
  │   NO → { found: true, redacted: true, ... }      [REDACTED - classification exceeded]
  │       + logRedaction(...)
  │
  └─ { found: true, content: entry.content, ... }    [FULL - allowed]
```

### 7.4 Detailed: memory_query

```
memory_query(query, filters)
  │
  ├─ Run DB query (FTS5 / vector / hybrid)
  │   → raw results (all namespaces)
  │
  ├─ filterByAccess(ctx, results)
  │   → remove entries in inaccessible namespaces     [INVISIBLE]
  │
  ├─ For each remaining entry:
  │   classificationAllowed(entry.classification, ctx.maxClassification)?
  │     NO → replace with redacted version            [REDACTED]
  │         + logRedaction(...)
  │     YES → keep full content                       [FULL]
  │
  ├─ total = count of post-access-filter results      [includes redacted]
  │   redacted_count = count of redacted entries       [new field]
  │
  └─ Return results (mix of full + redacted entries)
```

**Design decision:** Redacted entries ARE included in query results (with metadata only). This preserves result count accuracy and tells the user "there are N more relevant results you can see via Claude Code." The alternative (omitting them) would make consumer-Claude queries silently incomplete.

### 7.5 Detailed: memory_orient

```
memory_orient(params)
  │
  ├─ Load tracked status assessments
  │   → filterByAccess(ctx, assessments)               [INVISIBLE for inaccessible]
  │   → For accessible: classify each
  │       classification exceeded → redacted dashboard item
  │       classification allowed → full dashboard item
  │
  ├─ Load namespace overview
  │   → filterByAccess (existing)
  │   → Add classification_summary per namespace:
  │     { total_entries, redacted_count, highest_classification }
  │
  ├─ Conventions: unchanged (owner-only for full)
  │
  ├─ Notes (workbench-notes): classify and gate
  │
  ├─ Maintenance suggestions: filter to non-redacted
  │
  └─ New field: librarian_summary
      { enabled, transport_type, max_classification, redacted_dashboard_count }
```

The `librarian_summary` field in orient tells the caller:
- Whether the Librarian is active
- What their transport classification is
- How many dashboard items were redacted
- How to access full content

### 7.7 Derivative data lifecycle

Some tools persist derived content in separate tables. Notably, `memory_commitments` copies `text` and `source_excerpt` into the `commitments` table. This creates a second copy of potentially classified content outside the source entry.

**Problem:** If a source entry is reclassified upward (e.g., from `internal` to `client-confidential`), the copied text in derivative tables remains at the old classification. A consumer-transport query could then access the derivative copy even though the source is now protected.

**Rules for derivative data:**

1. **Derivative rows inherit source classification.** When `commitments`, patterns, or other derivative tables store copied content, they must also store a `source_entry_id` and `source_classification` column.

2. **Classification check on derivative reads.** When derived tools read back persisted rows (not just synthesize in-memory), they must check `source_classification` against `ctx.maxClassification` before including the row.

3. **Reclassification propagation.** When `memory_write` updates an entry's classification upward, a trigger or application-level hook updates `source_classification` in all derivative tables referencing that entry. This is a bounded operation (few derivatives per entry).

4. **Scrub on reclassification to `client-restricted`.** If a source entry is reclassified to `client-restricted`, derivative rows containing copied text are deleted (not just reclassified). The source entry is the authoritative copy; derivatives are expendable.

5. **No derivative storage of `client-restricted` content.** Derivative tables should never persist copied text from `client-restricted` entries. The pre-synthesis filter (§7.1.1) excludes these sources, so no derivative row is created.

**Schema addition for derivative tables:**

```sql
ALTER TABLE commitments ADD COLUMN source_entry_id TEXT;
ALTER TABLE commitments ADD COLUMN source_classification TEXT DEFAULT 'internal'
  CHECK(source_classification IN ('public', 'internal', 'client-confidential', 'client-restricted'));
```

---

## 8. Interaction Matrix

### 8.1 Classification × Transport

| Entry classification | `local` (stdio) | `dpa_covered` (Claude Code HTTP) | `consumer` (Claude.ai/Mobile) |
|---|---|---|---|
| `public` | Full | Full | Full |
| `internal` | Full | Full | Full |
| `client-confidential` | Full | Full | **Redacted** |
| `client-restricted` | Full | **Redacted** | **Redacted** |

### 8.2 Classification × Principal type (using defaults)

| Entry classification | Owner | Family (default) | Agent (default) | External (default) |
|---|---|---|---|---|
| `public` | Full | Full | Full | Full |
| `internal` | Full | Full | Full | Redacted |
| `client-confidential` | Per transport | Redacted | Redacted | Redacted |
| `client-restricted` | Per transport | Redacted | Redacted | Redacted |

### 8.3 Combined: Owner on different platforms

| Entry classification | Owner + stdio | Owner + Claude Code (HTTP) | Owner + Claude.ai (OAuth) |
|---|---|---|---|
| `public` | Full | Full | Full |
| `internal` | Full | Full | Full |
| `client-confidential` | Full | Full | **Redacted** |
| `client-restricted` | Full | **Redacted** | **Redacted** |

### 8.4 Combined: Access denied + Classification exceeded

| Scenario | Layer 1 (Access) | Layer 2 (Classification) | User sees |
|---|---|---|---|
| Sara reads `clients/lofalk/status` | Denied (no namespace rule) | N/A (Layer 1 stops it) | `{ found: false }` — INVISIBLE |
| Magnus via Claude.ai reads `clients/lofalk/status` | Allowed (owner) | Denied (client-confidential > internal) | Redacted metadata + reason |
| Magnus via Claude Code reads `clients/lofalk/status` | Allowed (owner) | Allowed (client-confidential <= client-confidential) | Full content |
| Agent:hugin reads `projects/foo/status` | Check namespace rules | Check agent max_classification | Depends on config |

---

## 9. Database Schema Changes

### 9.1 Migration (v7)

```sql
-- 1. Namespace classification floor table (data-driven policy)
CREATE TABLE IF NOT EXISTS namespace_classification (
  namespace_pattern TEXT PRIMARY KEY,
  min_classification TEXT NOT NULL
    CHECK(min_classification IN ('public', 'internal', 'client-confidential', 'client-restricted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Seed namespace floors (see §4.3 for rationale)
INSERT INTO namespace_classification (namespace_pattern, min_classification) VALUES
  ('clients/*', 'client-confidential'),
  ('people/*', 'client-confidential'),
  ('business/*', 'client-confidential'),
  ('projects/*', 'internal'),
  ('decisions/*', 'internal'),
  ('meta/*', 'internal'),
  ('documents/*', 'internal'),
  ('users/*', 'internal'),
  ('shared/*', 'internal'),
  ('signals/*', 'internal'),
  ('digests/*', 'internal'),
  ('tasks/*', 'internal'),
  ('briefings/*', 'internal'),
  ('rituals/*', 'internal'),
  ('reading/*', 'public'),
  ('demo/*', 'public');

-- 2. Add classification column to entries
ALTER TABLE entries ADD COLUMN classification TEXT NOT NULL DEFAULT 'internal'
  CHECK(classification IN ('public', 'internal', 'client-confidential', 'client-restricted'));

-- 3. Backfill from namespace defaults
UPDATE entries SET classification = 'client-confidential'
  WHERE namespace LIKE 'clients/%' OR namespace LIKE 'people/%' OR namespace LIKE 'business/%';

UPDATE entries SET classification = 'public'
  WHERE namespace LIKE 'reading/%' OR namespace LIKE 'demo/%';

-- Remaining entries keep 'internal' default

-- 4. Override from existing explicit tags (if any were manually set)
UPDATE entries SET classification = 'public'
  WHERE json_extract(tags, '$') LIKE '%"classification:public"%'
  AND classification != 'public';

UPDATE entries SET classification = 'client-confidential'
  WHERE json_extract(tags, '$') LIKE '%"classification:client-confidential"%'
  AND classification != 'client-confidential';

UPDATE entries SET classification = 'client-restricted'
  WHERE json_extract(tags, '$') LIKE '%"classification:client-restricted"%'
  AND classification != 'client-restricted';

UPDATE entries SET classification = 'internal'
  WHERE json_extract(tags, '$') LIKE '%"classification:internal"%'
  AND classification != 'internal';

-- 5. Add max_classification and transport_type to principals
ALTER TABLE principals ADD COLUMN max_classification TEXT DEFAULT NULL
  CHECK(max_classification IN ('public', 'internal', 'client-confidential', 'client-restricted'));

ALTER TABLE principals ADD COLUMN transport_type TEXT DEFAULT NULL
  CHECK(transport_type IN ('local', 'dpa_covered', 'consumer'));

-- 6. Create redaction audit log
CREATE TABLE IF NOT EXISTS redaction_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id TEXT,
  principal_id TEXT NOT NULL,
  transport_type TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  entry_namespace TEXT NOT NULL,
  entry_classification TEXT NOT NULL,
  connection_max_classification TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_redaction_log_created
  ON redaction_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_redaction_log_entry
  ON redaction_log(entry_id);

-- 7. Derivative data lifecycle columns (see §7.7)
-- (Applied conditionally — only if commitments table exists)
-- ALTER TABLE commitments ADD COLUMN source_entry_id TEXT;
-- ALTER TABLE commitments ADD COLUMN source_classification TEXT DEFAULT 'internal'
--   CHECK(source_classification IN ('public', 'internal', 'client-confidential', 'client-restricted'));
```

### 9.2 Index for classification filtering

```sql
-- Support efficient classification-based queries
CREATE INDEX IF NOT EXISTS idx_entries_classification
  ON entries(classification);

-- Composite for namespace + classification (common query pattern)
CREATE INDEX IF NOT EXISTS idx_entries_ns_classification
  ON entries(namespace, classification);
```

---

## 10. Configuration

### 10.1 Environment variables

| Variable | Default | Description |
|---|---|---|
| `MUNIN_LIBRARIAN_ENABLED` | `false` | Master switch for classification enforcement |
| `MUNIN_CLASSIFICATION_DEFAULT` | `internal` | Default classification for entries in unrecognized namespaces |
| `MUNIN_API_KEY_DPA` | — | Bearer token for DPA-covered connections (Claude Code). Required when Librarian is enabled. |
| `MUNIN_API_KEY_CONSUMER` | — | Bearer token for consumer connections (mcp-remote Desktop). Optional. |
| `MUNIN_API_KEY` | — | Legacy single bearer token. Backward compatible. Transport type configurable via `MUNIN_BEARER_TRANSPORT_TYPE`. |
| `MUNIN_BEARER_TRANSPORT_TYPE` | `dpa_covered` | Transport type for legacy `MUNIN_API_KEY` connections (deprecated — use dedicated keys) |
| `MUNIN_OAUTH_TRANSPORT_TYPE` | `consumer` | Transport type for OAuth connections |
| `MUNIN_REDACTION_LOG_ENABLED` | `true` | Log redaction events (disable for performance if needed) |
| `MUNIN_REDACTION_LOG_RETENTION_DAYS` | `365` | Retention for redaction audit log |

**Credential priority:** If both `MUNIN_API_KEY_DPA` and `MUNIN_API_KEY` are set, the server checks DPA key first, then consumer key, then legacy key. A request matching the legacy key is logged with a deprecation warning.

### 10.2 Principal configuration (via munin-admin)

```bash
# Set Sara's max classification (defense-in-depth alongside namespace rules)
npx munin-admin principals update sara --max-classification internal

# Set a local agent's max classification higher
npx munin-admin principals update agent:skuld --max-classification client-confidential --transport-type local

# Set a remote agent (e.g., Hugin on Pi) as DPA-covered
npx munin-admin principals update agent:hugin --max-classification client-confidential --transport-type dpa_covered
```

---

## 11. Audit & Compliance

### 11.1 Redaction audit trail

Every redaction event is logged to `redaction_log` with:
- Session ID (correlate with retrieval analytics)
- Principal ID (who tried to access)
- Transport type (which connection)
- Entry ID + namespace + classification (what was redacted)
- Connection's max classification (why it was redacted)
- Tool name (which tool triggered the redaction)
- Timestamp

### 11.2 Compliance queries

**Scope of evidence:** The redaction log proves the system actively blocked classified content. It does NOT prove that no leakage occurred elsewhere (e.g., via user copy-paste, misconfigured credentials, or a code path that bypasses the Librarian). Absence of bypass is established by code + tests + CI coverage, not by the log alone.

**Note on session correlation:** HTTP session IDs may be synthetic (derived from client ID + time bucket) due to MCP protocol limitations. Redaction logs correlate best at the entry/principal/timestamp level, not at the session level.

```sql
-- "Did the Librarian block classified content on consumer connections?"
-- Answer: check redaction_log. If entries exist, redaction WORKED.
SELECT COUNT(*) FROM redaction_log
  WHERE entry_classification = 'client-confidential'
  AND transport_type = 'consumer';

-- "Which entries are classified as client-confidential?"
SELECT namespace, key, classification FROM entries
  WHERE classification = 'client-confidential'
  ORDER BY namespace, key;

-- "Which entries use namespace defaults vs explicit classification?"
SELECT classification,
  CASE WHEN json_extract(tags, '$') LIKE '%"classification:%' THEN 'explicit' ELSE 'default' END as source,
  COUNT(*) as count
FROM entries GROUP BY 1, 2;
```

### 11.3 Startup consistency check

On server startup (when `MUNIN_LIBRARIAN_ENABLED=true`):

1. **Tag-column consistency:** Find entries where `classification:*` tag disagrees with `classification` column. Log warnings. The column is authoritative — fix the tag.
2. **Below-minimum entries:** Find entries classified below their namespace minimum. Log warnings. These may be legitimate (owner override) or legacy.
3. **Unclassified entries:** Find entries with `classification = 'internal'` in namespaces that default higher (e.g., entries in `clients/*` that weren't backfilled). This catches migration gaps.

These are warnings, not errors. The system operates with current state; warnings guide manual correction.

---

## 12. Implementation Plan

### Phase 1: Schema & classification (no enforcement)

1. **Migration v7:** Add `classification` column to entries, `namespace_classification` table (seeded), `max_classification` + `transport_type` to principals, `redaction_log` table. Backfill entry classifications from namespace defaults.
2. **New module:** `src/librarian.ts` — classification types, level comparison, namespace floor resolution, redaction formatting, tiered metadata policy, `enforceClassification` wrapper, `filterSourcesByClassification` helper.
3. **Write-time classification:** `memory_write` and `memory_log` set classification column on every write. Validate against namespace floor from DB table.
4. **Classification in responses:** All read tools include `classification` field in responses (informational, not enforced).
5. **Derivative data columns:** Add `source_entry_id` and `source_classification` to derivative tables (commitments).

**Outcome:** Classification data is populated and visible. No behavior changes. Safe to deploy.

### Phase 1.5: Mandatory classification audit (GATE — blocks Phase 2)

6. **Export all entries** with their proposed classifications based on namespace defaults.
7. **Review `projects/*` entries** — identify those containing client PII or client references → reclassify to `client-confidential`.
8. **Review `decisions/*` and `meta/*`** for similar leakage. Review any namespace that feeds derived tools, dashboards, or query previews.
9. **Document the audit results** — which entries were reclassified, why, and by whom.
10. **Verify derivative tables** — confirm `source_classification` is populated for existing derivative rows.

**Gate criterion:** Classification audit completed and documented. All `projects/*` entries reviewed. No unreviewed entries in namespaces that feed `memory_orient`, `memory_resume`, or other derived tools.

### Phase 2: Transport context & credential separation

11. **Generate dedicated credentials:** `MUNIN_API_KEY_DPA` and `MUNIN_API_KEY_CONSUMER` (separate values).
12. **Extend `verifyAccessToken`:** Recognize DPA key, consumer key, and legacy key separately. Map each to transport type.
13. **Extend AccessContext:** Add `maxClassification` and `transportType` fields.
14. **Transport resolution:** Update `resolveAccessContext` to compute effective max classification from `min(transport.max, principal.max)`. Enforce `local` = stdio only.
15. **Configure Claude Code** with `MUNIN_API_KEY_DPA`. Deprecate legacy key with warning.

**Outcome:** Transport attestation is credential-based. Server can mechanically distinguish DPA-covered from consumer connections.

### Phase 3: Enforcement

16. **Pattern A enforcement:** `enforceClassification` wrapper in all direct-entry tools (`memory_read`, `memory_read_batch`, `memory_get`, `memory_query`, `memory_list`, `memory_history`).
17. **Pattern B enforcement:** `filterSourcesByClassification` in all derived tools (`memory_orient`, `memory_resume`, `memory_handoff`, `memory_commitments`, `memory_narrative`, `memory_patterns`, `memory_attention`). Pre-synthesis filtering.
18. **Tiered redaction metadata:** Owner gets full metadata, non-owner gets minimal (§6.2).
19. **Librarian summary in orient:** Add `librarian_summary` to `memory_orient` response.
20. **CI coverage test:** Tool enumeration test verifying every content-returning tool has classification enforcement.
21. **Derivative data propagation:** Reclassification of source entries propagates to derivative tables.
22. **Enable `MUNIN_LIBRARIAN_ENABLED=true`.**

**Outcome:** Full enforcement. Consumer Claude sees public/internal data; client data is redacted with clear guidance.

### Phase 4: Audit, hardening & monitoring

23. **Redaction audit logging:** Log every redaction event to `redaction_log`.
24. **Startup consistency checks:** Tag-column, below-minimum, unclassified entry warnings. Floor table validation (overlaps, missing tracked namespaces).
25. **munin-admin extensions:** `--max-classification`, `--transport-type` flags. `classification set-floor`, `classification list-floors`, `classification audit` commands.
26. **Monitoring:** `memory_orient` reports Librarian status. Startup log message when Librarian is disabled. Log deprecation warnings for legacy `MUNIN_API_KEY` usage.
27. **Redaction log pruning:** Piggybacked on existing cleanup interval, retention per `MUNIN_REDACTION_LOG_RETENTION_DAYS`.

### Phase 5: Re-enable consumer access

28. **Re-enable OAuth MCP:** Turn on OAuth connectors for Claude.ai and Mobile.
29. **Re-enable mcp-remote for Desktop** (optional): Configure with `MUNIN_API_KEY_CONSUMER`.
30. **Verify end-to-end:** Test all platform × classification × principal combinations against the interaction matrix (§8).
31. **Update compliance documentation:** Record the Librarian in ROPA, LIA, and DPIA. Update the privacy documentation and gap analysis.

---

## 13. Testing Strategy

### 13.1 Unit tests (src/librarian.ts)

- Classification rank comparison (all 16 pair combinations)
- Namespace floor resolution from DB table (exact match, prefix match, no match, longest prefix wins, conflicting floors → higher wins)
- Redacted entry formatting — owner tier (full metadata present, content absent)
- Redacted entry formatting — non-owner tier (minimal metadata, no key/tags/timestamps)
- Write-time classification validation (accept valid, reject below minimum, accept owner override)
- Tag-column synchronization
- `enforceClassification` wrapper: valid entry, NULL classification (fail-closed), invalid value (fail-closed)
- `filterSourcesByClassification`: mixed sources, all allowed, all excluded, partial failure (unknown classification)

### 13.2 Integration tests (per tool)

Test matrix for each content-returning tool:

| Dimension | Values |
|---|---|
| Entry classification | public, internal, client-confidential, client-restricted |
| Transport type | local, dpa_covered, consumer |
| Principal type | owner, family, agent, external |
| Namespace access | allowed, denied |

**Critical combinations to test:**

| # | Scenario | Expected |
|---|---|---|
| 1 | Owner + local + client-restricted | Full content |
| 2 | Owner + dpa_covered + client-restricted | Redacted |
| 3 | Owner + dpa_covered + client-confidential | Full content |
| 4 | Owner + consumer + client-confidential | Redacted |
| 5 | Owner + consumer + internal | Full content |
| 6 | Family + any + client-confidential (default max: internal) | Redacted |
| 7 | Family + namespace denied + client-confidential | Invisible (not redacted) |
| 8 | Agent + dpa_covered + client-confidential (max: c-c) | Full content |
| 9 | Agent + consumer + internal | Full content |
| 10 | External + any + internal (default max: public) | Redacted |
| 11 | Librarian disabled + any combination | Full content (no filtering) |

### 13.3 Transport attestation tests

| Scenario | Expected |
|---|---|
| Bearer matching `MUNIN_API_KEY_DPA` | Transport: `dpa_covered` |
| Bearer matching `MUNIN_API_KEY_CONSUMER` | Transport: `consumer` |
| Bearer matching legacy `MUNIN_API_KEY` | Transport: per `MUNIN_BEARER_TRANSPORT_TYPE` + deprecation warning |
| OAuth token | Transport: `consumer` |
| Agent token with `transport_type: "local"` over HTTP | Downgraded to `dpa_covered` |
| Agent token with `transport_type: "dpa_covered"` over HTTP | Transport: `dpa_covered` |
| stdio connection | Transport: `local` (always, regardless of any config) |
| Unknown/invalid bearer token | ZERO_ACCESS + `consumer` transport |

### 13.4 Fail-closed tests

| Scenario | Expected |
|---|---|
| Entry with NULL classification column | Treated as `client-restricted` |
| Entry with invalid classification value | Treated as `client-restricted` |
| Principal with NULL max_classification | Use type default |
| Unknown transport type | Treated as `consumer` |
| `MUNIN_LIBRARIAN_ENABLED` not set | Disabled (no enforcement) |
| resolveAccessContext error | ZERO_ACCESS (existing) + consumer transport |
| Derived tool with one source having NULL classification | Source excluded, partial output returned |

### 13.5 Composition tests

Verify that access control and classification compose correctly:
- Namespace denied → invisible (never reaches classification check)
- Namespace allowed + classification allowed → full content
- Namespace allowed + classification denied → redacted with reason (owner: full metadata, non-owner: minimal)

### 13.6 Derived tool tests

For each Pattern B tool (`memory_orient`, `memory_resume`, `memory_handoff`, `memory_commitments`, `memory_narrative`, `memory_patterns`):
- Sources split correctly between allowed and excluded
- Synthesis only uses allowed sources (classified content does NOT appear in output)
- `redacted_sources` field present with correct metadata tier
- Partial failure: one source with unknown classification → excluded, rest synthesized
- All sources excluded → tool returns empty result + `redacted_sources` summary

### 13.7 Derivative lifecycle tests

- Source entry reclassified upward → `source_classification` in derivative table updated
- Source entry reclassified to `client-restricted` → derivative rows containing copied text deleted
- New derivative from `client-restricted` source → not persisted (filtered at synthesis time)

### 13.8 CI coverage test

- Enumerate all registered MCP tool names from `registerTools`
- For each content-returning tool, verify it calls `enforceClassification` (Pattern A) or `filterSourcesByClassification` (Pattern B)
- Fail if a new tool is added without classification handling

### 13.9 Audit tests

- Redaction events logged with correct fields
- No redaction logged when classification allows
- No redaction logged when Librarian is disabled
- Redaction log retention (pruning after MUNIN_REDACTION_LOG_RETENTION_DAYS)
- Floor table changes logged in audit_log

---

## 14. File Structure

```
src/
├── librarian.ts          # NEW: Classification types, level comparison, namespace floor resolution,
│                         #   redaction formatting, tiered metadata, enforceClassification wrapper,
│                         #   filterSourcesByClassification helper, derivative lifecycle hooks
├── access.ts             # MODIFIED: Extended AccessContext with maxClassification + transportType
├── tools.ts              # MODIFIED: Classification filtering in every read tool (Pattern A + B)
├── db.ts                 # MODIFIED: classification column in queries, redaction_log functions,
│                         #   namespace_classification table queries, derivative table columns
├── migrations.ts         # MODIFIED: Migration v7 (namespace_classification, entries.classification,
│                         #   principals columns, redaction_log, derivative columns)
├── admin-cli.ts          # MODIFIED: --max-classification, --transport-type, classification subcommand
│                         #   (set-floor, list-floors, audit)
├── oauth.ts              # MODIFIED: verifyAccessToken recognizes DPA/consumer/legacy bearer tokens
└── index.ts              # MODIFIED: Transport type determination, dedicated credential matching

tests/
├── librarian.test.ts           # NEW: Unit tests for classification logic, floor resolution, redaction
├── librarian-tools.test.ts     # NEW: Integration tests per tool (Pattern A + B enforcement)
├── librarian-derived.test.ts   # NEW: Pre-synthesis filtering, derivative lifecycle, partial failure
├── librarian-transport.test.ts # NEW: Credential-based transport resolution, HTTP-local downgrade
├── librarian-coverage.test.ts  # NEW: CI test enumerating all tools for classification enforcement
└── ... (existing test files)

docs/
├── librarian-architecture.md  # THIS DOCUMENT
└── authorization-matrix.md    # UPDATED: Classification dimension added
```

---

## 15. Open Questions

### Resolved by debate

1. **~~Should namespace floors be in code or DB?~~** → DB (§4.3). Codex critique C04: code-defined floors drift and fail open.
2. **~~How should transport be attested?~~** → Dedicated credentials per transport class (§5.2). Codex critique C01: auth method alone is not a trustworthy signal.
3. **~~Should derived tools redact output or filter input?~~** → Filter input before synthesis (§7.1.1). Codex critique C02: post-synthesis redaction is insufficient.
4. **~~What metadata should redacted entries expose?~~** → Tiered by principal type (§6.2). Codex critique C03: full metadata leaks relationships for non-owner.

### Still open

5. **Should `memory_query` return redacted entries in search results, or omit them entirely?** Current proposal: include them (with metadata only) so the user knows relevant results exist. Alternative: omit and add a `redacted_count` field. The tiered metadata policy (§6.2) mitigates the leakage concern for non-owner principals.

6. **Should classification be settable as a tool parameter on `memory_write`, or only via tags?** A dedicated parameter is cleaner but adds schema complexity. A tag-only approach uses existing infrastructure but is easier to accidentally omit.

7. **Redaction log retention.** 365 days proposed for compliance evidence. This is intentionally longer than `MUNIN_ANALYTICS_RETENTION_DAYS` (90 days) because redaction logs serve a legal purpose.

8. **Should `client-restricted` entries be completely invisible (like namespace denial) rather than redacted?** The tiered metadata policy reduces this concern — non-owner principals already get minimal metadata. For owner on downgraded transport, visibility is desired.

9. **How should future DPA-covered OAuth clients be handled?** If Anthropic adds DPA to a consumer tier, or a new OAuth client has its own DPA, the per-client transport type needs to be configurable. Currently all OAuth = `consumer`. May need a per-OAuth-client transport_type in `principal_oauth_clients`.

---

## 16. Security Properties (Summary)

| Property | How it's achieved |
|---|---|
| **No classified content in consumer AI** | Classification column + read-time filtering + redaction |
| **No classification bypass via queries** | Post-query filtering (Pattern A) + pre-synthesis filtering (Pattern B) |
| **No classification bypass via derived tools** | `filterSourcesByClassification` runs BEFORE any content synthesis or aggregation |
| **No classification downgrade by non-owners** | Write-time validation rejects below-namespace-minimum (from DB floor table) |
| **Transport attestation via credentials** | Dedicated `MUNIN_API_KEY_DPA` / `MUNIN_API_KEY_CONSUMER` — credential provisioning is the trust anchor |
| **HTTP cannot claim local transport** | Hard rule: `local` = stdio only. `client-restricted` entries accessible only via stdio. |
| **Fail-closed on unknown state** | Unknown classification → restricted. Unknown transport → consumer. NULL classification → excluded. |
| **Auditable redaction trail** | `redaction_log` table — proves blocking (not absence of leakage) |
| **Defense in depth** | DB constraint + write validation + read filtering + audit logging + CI coverage test |
| **Composable with access control** | Two independent layers. Access denial → invisible. Classification denial → redacted. |
| **Tiered metadata on redaction** | Owner gets full metadata. Non-owner gets namespace + reason only. Prevents relationship leakage. |
| **Derivative data lifecycle** | Reclassification propagates to derivative tables. `client-restricted` content never persisted in derivatives. |
| **Data-driven policy** | Namespace floors in DB, not code. Owner-only mutation. Audit-logged changes. Startup validation. |
| **Graceful degradation** | Librarian disabled → no enforcement. Missing column → fail-closed. Partial source failure → exclude + report. |
| **Mandatory audit gate** | Phase 1.5 blocks enforcement until classification inventory is reviewed (especially `projects/*`) |

## 17. Debate Record

This architecture was adversarially reviewed by Codex (GPT-5.4) on 2026-04-02. Two rounds, 15 critique points. Key changes from the debate:

| # | Finding | Severity | Resolution |
|---|---|---|---|
| C01 | Transport boundary not validated by trustworthy signal | Critical | Dedicated credentials per transport class (§5.2) |
| C02 | Derived tools are the real leak surface | Critical | Pre-synthesis source filtering (§7.1.1) |
| C03 | Visible redaction leaks relationships | Major | Tiered metadata policy: owner=full, non-owner=minimal (§6.2) |
| C04 | Namespace floors in code will drift | Major | DB-driven `namespace_classification` table (§4.3) |
| C05 | Fail-closed is tool-by-tool manual | Major | Centralized wrapper + CI tool enumeration test (§7.1.2) |
| C06 | Breaking API contract change | Major | Documented per tool; `redacted: true` field addition |
| C08 | No migration baseline for `projects/*` | Major | Mandatory Phase 1.5 classification audit (§12) |
| C10 | `client-restricted` depends on manual transport labeling | Major | HTTP can never be `local` — hard rule (§5.2) |
| C12 | Persisted derivative rows not addressed | Critical | Derivative data lifecycle rules (§7.7) |
| C13 | Mutable floor table is high-value target | Major | Owner-only, audit-logged, startup-validated (§4.3) |
| C15 | Partial-failure semantics for derived tools | Major | Exclude unknown-classification sources, return partial output (§7.1.1) |

Full debate: `debate/librarian-summary.md`
