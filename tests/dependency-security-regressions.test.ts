import { describe, expect, it } from "vitest";
import uri from "fast-uri";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const proxyaddr = require("proxy-addr") as {
  compile: (ranges: string[]) => (address: string, index: number) => boolean;
};

describe("proxy trust range dependency security (#359)", () => {
  it.each(["::ffff:10.0.0.0/8", "::/1"])(
    "does not widen a malformed mapped range to unrelated IPv4: %s",
    (range) => {
      const trust = proxyaddr.compile([range]);
      expect(trust("203.0.113.9", 0)).toBe(false);
      expect(trust("::ffff:203.0.113.9", 0)).toBe(false);
    },
  );

  it.each(["10.0.0.0/8", "::ffff:10.0.0.0/104"])(
    "preserves the intended IPv4 subnet for %s",
    (range) => {
      const trust = proxyaddr.compile([range]);
      expect(trust("10.20.30.40", 0)).toBe(true);
      expect(trust("203.0.113.9", 0)).toBe(false);
    },
  );
});

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
