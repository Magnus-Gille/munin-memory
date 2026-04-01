import { describe, it, expect } from "vitest";
import {
  scanForSecrets,
  validateNamespace,
  validateKey,
  validateContent,
  validateTags,
  validateWriteInput,
  validateLogInput,
} from "../src/security.js";

describe("scanForSecrets", () => {
  it("rejects OpenAI/Anthropic API keys", () => {
    const result = scanForSecrets("my key is sk-abc123def456ghi789jkl012mno345");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("API key");
  });

  it("rejects OpenAI project API keys (sk-proj-)", () => {
    const result = scanForSecrets("key: sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("OpenAI project API key");
  });

  it("rejects GitHub personal access tokens", () => {
    const result = scanForSecrets("token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("GitHub personal access token");
  });

  it("rejects GitHub OAuth tokens", () => {
    const result = scanForSecrets("token: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("GitHub OAuth token");
  });

  it("rejects GitHub fine-grained PATs", () => {
    const result = scanForSecrets("github_pat_ABCDEFGHIJKLMNOPQRSTUV");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("GitHub fine-grained PAT");
  });

  it("rejects Bearer tokens", () => {
    const result = scanForSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoidmFsdWUifQ");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Bearer token");
  });

  it("rejects private keys", () => {
    const result = scanForSecrets("-----BEGIN PRIVATE KEY----- some key data");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Private key");
  });

  it("rejects RSA private keys", () => {
    const result = scanForSecrets("-----BEGIN RSA PRIVATE KEY----- some key data");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Private key");
  });

  it("rejects certificates", () => {
    const result = scanForSecrets("-----BEGIN CERTIFICATE----- some cert");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Certificate");
  });

  it("rejects AWS access keys", () => {
    const result = scanForSecrets("aws_access_key_id = AKIAIOSFODNN7EXAMPLE");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("AWS access key");
  });

  it("rejects inline passwords", () => {
    const result = scanForSecrets('password = "myS3cretP@ss!"');
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Inline password");
  });

  it("rejects inline secrets", () => {
    const result = scanForSecrets("secret: 'a-very-long-secret-value'");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Inline secret");
  });

  it("allows prose mentioning Bearer auth scheme", () => {
    // This was a false positive — markdown table with "Bearer token" triggered the pattern
    expect(scanForSecrets("Auth uses Bearer token validation").valid).toBe(true);
    expect(scanForSecrets("| Bearer | API key or OAuth token |").valid).toBe(true);
    expect(scanForSecrets("The Bearer scheme is defined in RFC 6750").valid).toBe(true);
  });

  it("rejects short Bearer-like strings that are still real tokens", () => {
    // 20+ chars after "Bearer " should still be caught
    const result = scanForSecrets("Bearer abcdefghijklmnopqrst");
    expect(result.valid).toBe(false);
  });

  it("passes clean content", () => {
    const result = scanForSecrets(
      "Decided to use SQLite for the memory backend. The architecture uses FTS5 for search.",
    );
    expect(result.valid).toBe(true);
  });

  it("passes content mentioning secrets in general terms", () => {
    const result = scanForSecrets(
      "API keys should never be stored in memory. The security module rejects them.",
    );
    expect(result.valid).toBe(true);
  });
});

describe("validateNamespace", () => {
  it("accepts valid namespaces", () => {
    expect(validateNamespace("projects/hugin-munin").valid).toBe(true);
    expect(validateNamespace("people/magnus").valid).toBe(true);
    expect(validateNamespace("decisions/tech-stack").valid).toBe(true);
    expect(validateNamespace("meta").valid).toBe(true);
    expect(validateNamespace("a").valid).toBe(true);
  });

  it("rejects empty namespace", () => {
    expect(validateNamespace("").valid).toBe(false);
  });

  it("rejects namespace with spaces", () => {
    expect(validateNamespace("my project").valid).toBe(false);
  });

  it("rejects namespace with leading slash", () => {
    expect(validateNamespace("/projects").valid).toBe(false);
  });

  it("rejects namespace with special characters", () => {
    expect(validateNamespace("projects@home").valid).toBe(false);
    expect(validateNamespace("projects.v1").valid).toBe(false);
  });
});

describe("validateKey", () => {
  it("accepts valid keys", () => {
    expect(validateKey("status").valid).toBe(true);
    expect(validateKey("tech-stack").valid).toBe(true);
    expect(validateKey("my_preferences").valid).toBe(true);
    expect(validateKey("v2-plan").valid).toBe(true);
  });

  it("rejects empty key", () => {
    expect(validateKey("").valid).toBe(false);
  });

  it("rejects key with slashes", () => {
    expect(validateKey("a/b").valid).toBe(false);
  });

  it("rejects key with spaces", () => {
    expect(validateKey("my key").valid).toBe(false);
  });
});

describe("validateContent", () => {
  it("accepts normal content", () => {
    expect(validateContent("Hello world", 100000).valid).toBe(true);
  });

  it("rejects empty content", () => {
    expect(validateContent("", 100000).valid).toBe(false);
  });

  it("rejects oversized content", () => {
    const big = "x".repeat(100001);
    expect(validateContent(big, 100000).valid).toBe(false);
  });

  it("accepts content at max size", () => {
    const exact = "x".repeat(100000);
    expect(validateContent(exact, 100000).valid).toBe(true);
  });
});

describe("validateTags", () => {
  it("accepts valid tags", () => {
    expect(validateTags(["decision", "active", "raspberry-pi"]).valid).toBe(true);
  });

  it("accepts undefined/null tags", () => {
    expect(validateTags(undefined).valid).toBe(true);
    expect(validateTags(null).valid).toBe(true);
  });

  it("accepts empty array", () => {
    expect(validateTags([]).valid).toBe(true);
  });

  it("rejects non-array", () => {
    expect(validateTags("not-an-array").valid).toBe(false);
  });

  it("rejects too many tags", () => {
    const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    expect(validateTags(tags).valid).toBe(false);
  });

  it("rejects tags with spaces", () => {
    expect(validateTags(["good-tag", "bad tag"]).valid).toBe(false);
  });

  it("rejects tags with special chars", () => {
    expect(validateTags(["@invalid"]).valid).toBe(false);
  });

  it("accepts prefixed tags with colons", () => {
    expect(validateTags(["client:lofalk", "person:sara", "topic:ai-education", "type:pdf", "source:external"]).valid).toBe(true);
  });

  it("rejects tags starting with colon", () => {
    expect(validateTags([":invalid"]).valid).toBe(false);
  });

  it("accepts mixed colon and hyphen tags", () => {
    expect(validateTags(["type:meeting-notes", "client:lofalk-industries"]).valid).toBe(true);
  });
});

describe("validateWriteInput", () => {
  it("passes with all valid inputs", () => {
    const result = validateWriteInput("projects/test", "status", "All good", ["active"], 100000);
    expect(result.valid).toBe(true);
  });

  it("fails on invalid namespace", () => {
    const result = validateWriteInput("/bad", "status", "content", undefined, 100000);
    expect(result.valid).toBe(false);
  });

  it("fails on secret in content", () => {
    const result = validateWriteInput("projects/test", "status", "key: sk-abcdefghijklmnopqrstuvwx", undefined, 100000);
    expect(result.valid).toBe(false);
  });
});

describe("validateLogInput", () => {
  it("passes with valid inputs", () => {
    const result = validateLogInput("projects/test", "Something happened", undefined, 100000);
    expect(result.valid).toBe(true);
  });

  it("fails on invalid namespace", () => {
    const result = validateLogInput("", "content", undefined, 100000);
    expect(result.valid).toBe(false);
  });
});
