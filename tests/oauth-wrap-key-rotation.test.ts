import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../src/db.js";
import { MuninClientsStore, deriveClientSecretWrapKey, rewrapClientSecrets } from "../src/oauth.js";
import { handleOAuthClientsRewrap, parseArgs } from "../src/admin-cli.js";
import { createTestStorage } from "./helpers/test-storage.js";

const STORAGE = createTestStorage("oauth-wrap-rotation");
afterAll(STORAGE.cleanup);

const OLD = deriveClientSecretWrapKey("old-wrap-key-material");
const NEW = deriveClientSecretWrapKey("new-wrap-key-material");

function client(id: string, secret: string) {
  return {
    client_id: id,
    client_secret: secret,
    redirect_uris: [new URL("http://localhost:3000/cb")],
    token_endpoint_auth_method: "client_secret_post",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };
}

let db: Database.Database;
beforeEach(() => {
  db = initDatabase(STORAGE.path);
  db.exec("DELETE FROM oauth_clients");
});
afterEach(() => {
  db.close();
});

describe("rewrapClientSecrets", () => {
  it("re-encrypts so clients read back under the new key only", async () => {
    await new MuninClientsStore(db, OLD).registerClient(client("a", "secret-a"));
    await new MuninClientsStore(db, OLD).registerClient(client("b", "secret-b"));
    const res = rewrapClientSecrets(db, OLD, NEW);
    expect(res).toMatchObject({ total: 2, rewrapped: 2, alreadyOnNewKey: 0 });
    const store = new MuninClientsStore(db, NEW);
    expect((await store.getClient("a"))?.client_secret).toBe("secret-a");
    expect((await store.getClient("b"))?.client_secret).toBe("secret-b");
    await expect(new MuninClientsStore(db, OLD).getClient("a")).rejects.toThrow();
  });

  it("is idempotent", async () => {
    await new MuninClientsStore(db, OLD).registerClient(client("a", "secret-a"));
    rewrapClientSecrets(db, OLD, NEW);
    const again = rewrapClientSecrets(db, OLD, NEW);
    expect(again).toMatchObject({ rewrapped: 0, alreadyOnNewKey: 1 });
  });

  it("dry run writes nothing", async () => {
    await new MuninClientsStore(db, OLD).registerClient(client("a", "secret-a"));
    const res = rewrapClientSecrets(db, OLD, NEW, { dryRun: true });
    expect(res).toMatchObject({ rewrapped: 1, dryRun: true });
    expect((await new MuninClientsStore(db, OLD).getClient("a"))?.client_secret).toBe("secret-a");
  });

  it("aborts atomically when a row matches neither key", async () => {
    await new MuninClientsStore(db, OLD).registerClient(client("a", "secret-a"));
    const other = deriveClientSecretWrapKey("unrelated");
    await new MuninClientsStore(db, other).registerClient(client("z", "secret-z"));
    expect(() => rewrapClientSecrets(db, OLD, NEW)).toThrow(/Client z/);
    expect((await new MuninClientsStore(db, OLD).getClient("a"))?.client_secret).toBe("secret-a");
  });

  it("refuses identical keys", () => {
    expect(() => rewrapClientSecrets(db, OLD, OLD)).toThrow(/identical/);
  });

  it("does not leak secrets in the abort error", async () => {
    const other = deriveClientSecretWrapKey("unrelated");
    await new MuninClientsStore(db, other).registerClient(client("z", "super-secret-z"));
    try {
      rewrapClientSecrets(db, OLD, NEW);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("super-secret-z");
    }
  });

  it("hashes key material exactly as given (runtime parity)", () => {
    expect(deriveClientSecretWrapKey(" k ").equals(deriveClientSecretWrapKey("k"))).toBe(false);
  });

  it("writes the audit row inside the same transaction", async () => {
    await new MuninClientsStore(db, OLD).registerClient(client("a", "secret-a"));
    expect(() =>
      rewrapClientSecrets(db, OLD, NEW, {
        audit: () => {
          throw new Error("audit failed");
        },
      }),
    ).toThrow(/audit failed/);
    // rolled back: still readable under the old key
    expect((await new MuninClientsStore(db, OLD).getClient("a"))?.client_secret).toBe("secret-a");
  });
});

describe("admin rewrap-secrets keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "wrapkey-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects group/other-readable key files", () => {
    const f = join(dir, "old");
    writeFileSync(f, "old-wrap-key-material");
    chmodSync(f, 0o644);
    const g = join(dir, "new");
    writeFileSync(g, "new-wrap-key-material");
    chmodSync(g, 0o600);
    expect(() =>
      handleOAuthClientsRewrap(db, new Map([["--old-key-file", f], ["--new-key-file", g]]), true),
    ).toThrow(/chmod 600/);
  });

  it("rewraps using 0600 key files", async () => {
    await new MuninClientsStore(db, OLD).registerClient(client("a", "secret-a"));
    const f = join(dir, "old2");
    const g = join(dir, "new2");
    writeFileSync(f, "old-wrap-key-material\n", { mode: 0o600 });
    writeFileSync(g, "new-wrap-key-material\n", { mode: 0o600 });
    handleOAuthClientsRewrap(db, new Map([["--old-key-file", f], ["--new-key-file", g]]), true);
    expect((await new MuninClientsStore(db, NEW).getClient("a"))?.client_secret).toBe("secret-a");
  });

  it("accepts keys from environment variables and writes an audit row", async () => {
    await new MuninClientsStore(db, OLD).registerClient(client("a", "secret-a"));
    process.env.MUNIN_OAUTH_WRAP_KEY_OLD = "old-wrap-key-material";
    process.env.MUNIN_OAUTH_WRAP_KEY_NEW = "new-wrap-key-material";
    try {
      handleOAuthClientsRewrap(db, new Map(), true);
    } finally {
      delete process.env.MUNIN_OAUTH_WRAP_KEY_OLD;
      delete process.env.MUNIN_OAUTH_WRAP_KEY_NEW;
    }
    expect((await new MuninClientsStore(db, NEW).getClient("a"))?.client_secret).toBe("secret-a");
    const row = db.prepare("SELECT detail FROM audit_log WHERE action = 'oauth_wrap_key_rewrap'").get() as { detail: string };
    expect(JSON.parse(row.detail).rewrapped).toBe(1);
  });

  it("errors when no key source is given", () => {
    delete process.env.MUNIN_OAUTH_WRAP_KEY_OLD;
    delete process.env.MUNIN_OAUTH_WRAP_KEY_NEW;
    expect(() => handleOAuthClientsRewrap(db, new Map(), true)).toThrow(/Missing key/);
  });
});

describe("rewrap edge cases", () => {
  it("handles mixed state and plaintext rows", async () => {
    await new MuninClientsStore(db, OLD).registerClient(client("a", "secret-a"));
    await new MuninClientsStore(db, NEW).registerClient(client("b", "secret-b"));
    await new MuninClientsStore(db, OLD).registerClient(client("c", "secret-c"));
    // set plaintext last: constructing a store would otherwise upgrade it
    db.prepare("UPDATE oauth_clients SET client_secret = 'plain' WHERE client_id = 'a'").run();
    const res = rewrapClientSecrets(db, OLD, NEW);
    expect(res).toMatchObject({ total: 3, rewrapped: 1, alreadyOnNewKey: 1, plaintextSkipped: 1 });
    expect((db.prepare("SELECT client_secret s FROM oauth_clients WHERE client_id='a'").get() as { s: string }).s).toBe("plain");
  });

  it("swapped keys report everything as already on new key and write nothing", async () => {
    await new MuninClientsStore(db, OLD).registerClient(client("a", "secret-a"));
    const res = rewrapClientSecrets(db, NEW, OLD);
    expect(res).toMatchObject({ rewrapped: 0, alreadyOnNewKey: 1 });
  });

  it("dry run writes no audit row", async () => {
    await new MuninClientsStore(db, OLD).registerClient(client("a", "secret-a"));
    let called = false;
    rewrapClientSecrets(db, OLD, NEW, { dryRun: true, audit: () => { called = true; } });
    expect(called).toBe(false);
  });

  it("parseArgs rejects an empty --db and accepts --dry-run as a flag", () => {
    expect(() => parseArgs(["node", "x", "--db", " ", "principals", "list"])).toThrow(/non-empty/);
    expect(parseArgs(["node", "x", "oauth-clients", "rewrap-secrets", "--dry-run"]).flags.get("--dry-run")).toBe("true");
  });

  it("rejects symlinked and empty key files", () => {
    const d = mkdtempSync(join(tmpdir(), "wrapkey2-"));
    try {
      const real = join(d, "real");
      writeFileSync(real, "k", { mode: 0o600 });
      symlinkSync(real, join(d, "link"));
      writeFileSync(join(d, "empty"), "\n", { mode: 0o600 });
      const ok = join(d, "ok");
      writeFileSync(ok, "k2", { mode: 0o600 });
      expect(() => handleOAuthClientsRewrap(db, new Map([["--old-key-file", join(d, "link")], ["--new-key-file", ok]]), true)).toThrow();
      expect(() => handleOAuthClientsRewrap(db, new Map([["--old-key-file", join(d, "empty")], ["--new-key-file", ok]]), true)).toThrow(/Missing key/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
