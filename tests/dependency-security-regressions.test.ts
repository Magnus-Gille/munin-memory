import { describe, expect, it } from "vitest";
import uri from "fast-uri";

describe("SDK URI resolver dependency security (#356)", () => {
  it.each(["@127.0.0.1:8124", "443@evil.example", "443/ignored"])(
    "rejects authority delimiters in the port: %s",
    (port) => {
      const components = () => ({
        scheme: "https",
        host: "trusted.example",
        port,
        path: "/app",
      });

      expect(() => uri.serialize(components())).toThrow();
      expect(() => uri.normalize(components())).toThrow();
    },
  );

  it("canonicalizes percent-encoded scheme-relative host names", () => {
    expect(uri.parse("//%41.com").host).toBe("a.com");
    expect(uri.parse("//A.com").host).toBe("a.com");
    expect(uri.parse("//a.com").host).toBe("a.com");
    expect(uri.equal("//%41.com", "//a.com")).toBe(true);
  });

  it("preserves legitimate URI resolution and normalization", () => {
    expect(uri.serialize({
      scheme: "https",
      host: "trusted.example",
      port: 443,
      path: "/app",
    })).toBe("https://trusted.example/app");
    expect(uri.normalize("https://TRUSTED.example:443/app")).toBe(
      "https://trusted.example/app",
    );
    expect(uri.resolve("https://trusted.example/base/", "../app")).toBe(
      "https://trusted.example/app",
    );
  });
});
