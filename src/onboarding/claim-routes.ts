/**
 * Express routes for device claiming and admin operations.
 * - Claim: mounted in RUNNING_UNCLAIMED state
 * - Admin (reset, regenerate-key): mounted in CLAIMED state
 */

import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import { timingSafeEqual, randomBytes, createHash } from "node:crypto";
import { writeFileSync, renameSync, openSync, closeSync } from "node:fs";
import { fdatasyncSync } from "node:fs";
import { DeviceState, hashSecret } from "./state.js";
import type { DeviceStateData } from "./state.js";
import { renderClaimPage } from "./pages/claim.js";
import { renderClaimedPage, renderAlreadyClaimedPage } from "./pages/claimed.js";

// --- Rate limiting for claim/admin endpoints ---

interface ClaimRateLimiter {
  attempts: Map<string, { count: number; lastAttempt: number; lockedUntil: number }>;
}

const MAX_ATTEMPTS_PER_MINUTE = 5;
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes

function createClaimRateLimiter(): ClaimRateLimiter {
  return { attempts: new Map() };
}

function checkClaimRate(limiter: ClaimRateLimiter, ip: string, now = Date.now()): { allowed: boolean; retryAfter?: number } {
  let entry = limiter.attempts.get(ip);

  if (!entry) {
    entry = { count: 0, lastAttempt: now, lockedUntil: 0 };
    limiter.attempts.set(ip, entry);
  }

  // Check lockout
  if (entry.lockedUntil > now) {
    return { allowed: false, retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) };
  }

  // Reset count if more than a minute has passed
  if (now - entry.lastAttempt > 60_000) {
    entry.count = 0;
  }

  entry.count++;
  entry.lastAttempt = now;

  // Lock out after threshold
  if (entry.count >= LOCKOUT_THRESHOLD) {
    entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    return { allowed: false, retryAfter: Math.ceil(LOCKOUT_DURATION_MS / 1000) };
  }

  // Per-minute limit
  if (entry.count > MAX_ATTEMPTS_PER_MINUTE) {
    return { allowed: false, retryAfter: 60 };
  }

  return { allowed: true };
}

function verifyClaimCode(input: string, storedHash: string): boolean {
  const inputHash = createHash("sha256").update(input.toUpperCase().trim()).digest();
  const expectedHash = Buffer.from(storedHash, "hex");
  if (inputHash.length !== expectedHash.length) return false;
  return timingSafeEqual(inputHash, expectedHash);
}

// --- Deps ---

export interface ClaimDeps {
  deviceState: DeviceState;
  envFilePath: string;
  hostname: string;
  ip?: string;
  onTransition: () => void;
}

// --- Claim routes (RUNNING_UNCLAIMED) ---

export function createClaimRoutes(deps: ClaimDeps): Router {
  const router = createRouter();
  const rateLimiter = createClaimRateLimiter();

  router.get("/setup/claim", (req: Request, res: Response) => {
    const current = deps.deviceState.load();
    if (!current) {
      res.status(500).send("Device not initialized");
      return;
    }

    if (current.state === "CLAIMED") {
      res.type("html").send(renderAlreadyClaimedPage({
        deviceId: current.deviceId,
        hostname: deps.hostname,
      }));
      return;
    }

    res.type("html").send(renderClaimPage({
      deviceId: current.deviceId,
      hostname: deps.hostname,
      ip: deps.ip,
    }));
  });

  router.post("/setup/claim", (req: Request, res: Response) => {
    const current = deps.deviceState.load();
    if (!current) {
      res.status(500).send("Device not initialized");
      return;
    }

    if (current.state === "CLAIMED") {
      res.status(409).type("html").send(renderAlreadyClaimedPage({
        deviceId: current.deviceId,
        hostname: deps.hostname,
      }));
      return;
    }

    // Rate limit
    const clientIp = req.ip ?? "unknown";
    const rateCheck = checkClaimRate(rateLimiter, clientIp);
    if (!rateCheck.allowed) {
      res.status(429).type("html").send(renderClaimPage({
        deviceId: current.deviceId,
        hostname: deps.hostname,
        ip: deps.ip,
        error: `Too many attempts. Try again in ${rateCheck.retryAfter} seconds.`,
      }));
      return;
    }

    const claimCode = (req.body?.claimCode as string) ?? "";
    if (!claimCode || claimCode.length < 6) {
      res.type("html").send(renderClaimPage({
        deviceId: current.deviceId,
        hostname: deps.hostname,
        ip: deps.ip,
        error: "Please enter your 6-character claim code.",
      }));
      return;
    }

    if (!verifyClaimCode(claimCode, current.claimCodeHash)) {
      res.status(403).type("html").send(renderClaimPage({
        deviceId: current.deviceId,
        hostname: deps.hostname,
        ip: deps.ip,
        error: "Invalid claim code. Check your quick-start card and try again.",
      }));
      return;
    }

    // Generate API key
    const apiKey = randomBytes(32).toString("hex");
    const apiKeyHash = hashSecret(apiKey);

    // Write .env atomically
    writeEnvFile(deps.envFilePath, apiKey);

    // Transition to CLAIMED
    deps.deviceState.transition("RUNNING_UNCLAIMED", "CLAIMED", {
      claimedAt: new Date().toISOString(),
      apiKeyHash,
    });

    // Show success page with key
    res.type("html").send(renderClaimedPage({
      apiKey,
      deviceId: current.deviceId,
      hostname: deps.hostname,
      ip: deps.ip,
    }));

    // Schedule restart to enter claimed mode (give user time to copy key)
    setTimeout(() => deps.onTransition(), 60_000);
  });

  // Redirect root to claim when in RUNNING_UNCLAIMED
  router.get("/", (req: Request, res: Response) => {
    res.redirect("/setup/claim");
  });

  return router;
}

// --- Admin routes (CLAIMED) ---

export function createAdminRoutes(deps: ClaimDeps): Router {
  const router = createRouter();
  const rateLimiter = createClaimRateLimiter();

  router.post("/admin/regenerate-key", (req: Request, res: Response) => {
    const current = deps.deviceState.load();
    if (!current || current.state !== "CLAIMED") {
      res.status(404).json({ error: "Device not claimed" });
      return;
    }

    // Rate limit
    const clientIp = req.ip ?? "unknown";
    const rateCheck = checkClaimRate(rateLimiter, clientIp);
    if (!rateCheck.allowed) {
      res.status(429).json({ error: "Too many attempts", retryAfter: rateCheck.retryAfter });
      return;
    }

    const claimCode = (req.body?.claimCode as string) ?? "";
    if (!verifyClaimCode(claimCode, current.claimCodeHash)) {
      res.status(403).json({ error: "Invalid claim code" });
      return;
    }

    // Generate new API key
    const apiKey = randomBytes(32).toString("hex");
    const apiKeyHash = hashSecret(apiKey);

    // Write .env atomically
    writeEnvFile(deps.envFilePath, apiKey);

    // Update state (direct save — no state transition, just updating the hash)
    const data = deps.deviceState.load()!;
    data.apiKeyHash = apiKeyHash;
    deps.deviceState.save(data);

    res.json({
      apiKey,
      message: "API key regenerated. Old key is now invalid. Restart required.",
      mcpConfig: {
        "munin-memory": {
          url: `http://${deps.hostname}:3030/mcp`,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    });

    // Restart to pick up new key
    setTimeout(() => deps.onTransition(), 5_000);
  });

  router.post("/admin/reset", (req: Request, res: Response) => {
    const current = deps.deviceState.load();
    if (!current || current.state !== "CLAIMED") {
      res.status(404).json({ error: "Device not claimed" });
      return;
    }

    // Rate limit
    const clientIp = req.ip ?? "unknown";
    const rateCheck = checkClaimRate(rateLimiter, clientIp);
    if (!rateCheck.allowed) {
      res.status(429).json({ error: "Too many attempts", retryAfter: rateCheck.retryAfter });
      return;
    }

    const claimCode = (req.body?.claimCode as string) ?? "";
    if (!verifyClaimCode(claimCode, current.claimCodeHash)) {
      res.status(403).json({ error: "Invalid claim code" });
      return;
    }

    // Transition to FACTORY_RESET
    deps.deviceState.transition("CLAIMED", "FACTORY_RESET");

    res.json({ message: "Factory reset initiated. Device will restart in setup mode." });

    // Restart — boot reconciliation will complete the reset
    setTimeout(() => deps.onTransition(), 2_000);
  });

  return router;
}

// --- Helpers ---

function writeEnvFile(path: string, apiKey: string): void {
  const content = [
    "# Munin Memory — generated by onboarding",
    `MUNIN_API_KEY=${apiKey}`,
    "MUNIN_TRANSPORT=http",
    "MUNIN_HTTP_PORT=3030",
    "MUNIN_HTTP_HOST=0.0.0.0",
    "",
  ].join("\n");

  const tmpPath = path + ".tmp." + randomBytes(4).toString("hex");
  writeFileSync(tmpPath, content, { mode: 0o600 });
  const fd = openSync(tmpPath, "r");
  try {
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}
