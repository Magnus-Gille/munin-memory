/**
 * OAuth 2.1 server provider for Munin Memory.
 *
 * Implements the MCP SDK's OAuthServerProvider interface backed by SQLite.
 * Supports dual auth: legacy Bearer token (MUNIN_API_KEY) + OAuth access tokens.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Response } from "express";
import type Database from "better-sqlite3";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { nowUTC } from "./db.js";
import { renderConsentPage } from "./consent.js";

// --- Configuration ---

const ACCESS_TOKEN_TTL = parseInt(
  process.env.MUNIN_OAUTH_ACCESS_TOKEN_TTL ?? "3600",
  10,
);
const REFRESH_TOKEN_TTL = parseInt(
  process.env.MUNIN_OAUTH_REFRESH_TOKEN_TTL ?? String(30 * 24 * 3600),
  10,
);
const AUTH_CODE_TTL = 600; // 10 minutes
const CLIENT_SECRET_WRAP_PREFIX = "enc:v1:";

// --- DB row types ---

interface OAuthClientRow {
  client_id: string;
  client_secret: string | null;
  client_id_issued_at: number | null;
  client_secret_expires_at: number | null;
  redirect_uris: string;
  client_name: string | null;
  client_uri: string | null;
  logo_uri: string | null;
  scope: string | null;
  token_endpoint_auth_method: string | null;
  grant_types: string;
  response_types: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface OAuthAuthCodeRow {
  code: string;
  client_id: string;
  code_challenge: string;
  redirect_uri: string;
  scopes: string;
  resource: string | null;
  state: string | null;
  expires_at: number;
  used: number;
  created_at: string;
}

interface OAuthTokenRow {
  token: string;
  token_type: "access" | "refresh";
  client_id: string;
  scopes: string;
  resource: string | null;
  expires_at: number;
  revoked: number;
  created_at: string;
  refresh_token_ref: string | null;
}

// --- Clients Store ---

export class MuninClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private db: Database.Database,
    private clientSecretWrapKey?: Buffer,
  ) {
    this.upgradeLegacyClientSecrets();
  }

  async getClient(
    clientId: string,
  ): Promise<OAuthClientInformationFull | undefined> {
    const row = this.db
      .prepare("SELECT * FROM oauth_clients WHERE client_id = ?")
      .get(clientId) as OAuthClientRow | undefined;

    if (!row) return undefined;
    return rowToClientInfo(row, this.clientSecretWrapKey);
  }

  async registerClient(
    client: OAuthClientInformationFull,
  ): Promise<OAuthClientInformationFull> {
    const now = nowUTC();
    const storedClientSecret = client.client_secret
      ? encryptClientSecret(client.client_secret, this.clientSecretWrapKey)
      : null;

    this.db
      .prepare(
        `INSERT INTO oauth_clients
         (client_id, client_secret, client_id_issued_at, client_secret_expires_at,
          redirect_uris, client_name, client_uri, logo_uri, scope,
          token_endpoint_auth_method, grant_types, response_types, metadata,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        client.client_id,
        storedClientSecret,
        client.client_id_issued_at ?? null,
        client.client_secret_expires_at ?? null,
        JSON.stringify(client.redirect_uris.map((u) => u.toString())),
        client.client_name ?? null,
        client.client_uri?.toString() ?? null,
        client.logo_uri?.toString() ?? null,
        client.scope ?? null,
        client.token_endpoint_auth_method ?? null,
        JSON.stringify(client.grant_types ?? []),
        JSON.stringify(client.response_types ?? []),
        JSON.stringify({}),
        now,
        now,
      );

    return client;
  }

  private upgradeLegacyClientSecrets(): void {
    if (!this.clientSecretWrapKey) return;

    const rows = this.db
      .prepare("SELECT client_id, client_secret FROM oauth_clients WHERE client_secret IS NOT NULL")
      .all() as Array<{ client_id: string; client_secret: string }>;

    for (const row of rows) {
      if (isEncryptedClientSecret(row.client_secret)) continue;
      const encrypted = encryptClientSecret(row.client_secret, this.clientSecretWrapKey);
      this.db
        .prepare("UPDATE oauth_clients SET client_secret = ?, updated_at = ? WHERE client_id = ?")
        .run(encrypted, nowUTC(), row.client_id);
    }
  }
}

// --- Pending authorization transaction ---

interface PendingAuth {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  state?: string;
  resource?: string;
  expiresAt: number;
}

function hashOpaqueValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// --- OAuth Provider ---

export class MuninOAuthProvider implements OAuthServerProvider {
  public readonly clientsStore: MuninClientsStore;
  private readonly legacyApiKey: string | undefined;
  private readonly legacyApiKeyBuf: Buffer | undefined;
  private readonly clientSecretWrapKey: Buffer | undefined;
  private readonly pendingAuths = new Map<string, PendingAuth>();

  constructor(
    private db: Database.Database,
    legacyApiKey?: string,
  ) {
    this.legacyApiKey = legacyApiKey;
    this.legacyApiKeyBuf = legacyApiKey ? Buffer.from(legacyApiKey) : undefined;
    this.clientSecretWrapKey = getClientSecretWrapKey(legacyApiKey);
    this.clientsStore = new MuninClientsStore(db, this.clientSecretWrapKey);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Store validated params server-side, keyed by a nonce.
    // The consent page only receives the nonce — no security-critical
    // params in hidden form fields.
    const nonce = randomBytes(32).toString("hex");
    this.pendingAuths.set(nonce, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      state: params.state,
      resource: params.resource?.toString(),
      expiresAt: Math.floor(Date.now() / 1000) + AUTH_CODE_TTL,
    });

    const html = renderConsentPage({
      clientName: client.client_name ?? client.client_id,
      scopes: params.scopes ?? [],
      nonce,
    });

    res.setHeader("Content-Type", "text/html");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    res.send(html);
  }

  /**
   * Look up a pending authorization by nonce. Returns and removes the
   * pending auth if found and not expired. Returns undefined otherwise.
   */
  consumePendingAuth(nonce: string): PendingAuth | undefined {
    const pending = this.pendingAuths.get(nonce);
    if (!pending) return undefined;

    this.pendingAuths.delete(nonce);

    const nowSecs = Math.floor(Date.now() / 1000);
    if (pending.expiresAt < nowSecs) return undefined;

    return pending;
  }

  /**
   * Called from the /authorize/approve POST handler after user consent.
   * Takes server-validated params from the pending auth lookup.
   * Generates an auth code and redirects back to the client.
   */
  completeAuthorization(
    pending: PendingAuth,
    res: Response,
  ): void {
    const code = randomBytes(32).toString("hex");
    const codeHash = hashOpaqueValue(code);
    const now = nowUTC();
    const expiresAt = Math.floor(Date.now() / 1000) + AUTH_CODE_TTL;

    this.db
      .prepare(
        `INSERT INTO oauth_auth_codes
         (code, client_id, code_challenge, redirect_uri, scopes, resource, state, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        codeHash,
        pending.clientId,
        pending.codeChallenge,
        pending.redirectUri,
        JSON.stringify(pending.scopes),
        pending.resource ?? null,
        pending.state ?? null,
        expiresAt,
        now,
      );

    const targetUrl = new URL(pending.redirectUri);
    targetUrl.searchParams.set("code", code);
    if (pending.state) {
      targetUrl.searchParams.set("state", pending.state);
    }
    res.redirect(targetUrl.toString());
  }

  /**
   * Called from the /authorize/approve POST handler when user denies.
   * Takes server-validated params from the pending auth lookup.
   */
  denyAuthorization(
    pending: Pick<PendingAuth, "redirectUri" | "state">,
    res: Response,
  ): void {
    const targetUrl = new URL(pending.redirectUri);
    targetUrl.searchParams.set("error", "access_denied");
    targetUrl.searchParams.set(
      "error_description",
      "The user denied the authorization request",
    );
    if (pending.state) {
      targetUrl.searchParams.set("state", pending.state);
    }
    res.redirect(targetUrl.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const codeHash = hashOpaqueValue(authorizationCode);
    const row = this.db
      .prepare(
        "SELECT code_challenge FROM oauth_auth_codes WHERE code = ? AND used = 0",
      )
      .get(codeHash) as { code_challenge: string } | undefined;

    if (!row) {
      throw new Error("Invalid or expired authorization code");
    }
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const codeHash = hashOpaqueValue(authorizationCode);

    // Atomically claim the code: UPDATE ... WHERE used = 0, check changes === 1
    const claimed = this.db
      .prepare("UPDATE oauth_auth_codes SET used = 1 WHERE code = ? AND used = 0")
      .run(codeHash);

    if (claimed.changes !== 1) {
      throw new Error("Invalid or expired authorization code");
    }

    // Now read the code data (already marked used, safe from replay)
    const row = this.db
      .prepare("SELECT * FROM oauth_auth_codes WHERE code = ?")
      .get(codeHash) as OAuthAuthCodeRow | undefined;

    if (!row) {
      throw new Error("Invalid or expired authorization code");
    }

    if (row.client_id !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }

    const nowSecs = Math.floor(Date.now() / 1000);
    if (row.expires_at < nowSecs) {
      throw new Error("Authorization code has expired");
    }

    // RFC 6749 Section 4.1.3: if redirect_uri was included in the authorization
    // request, it MUST be identical in the token request
    if (redirectUri && row.redirect_uri && redirectUri !== row.redirect_uri) {
      throw new Error("redirect_uri does not match the authorization request");
    }

    const scopes: string[] = JSON.parse(row.scopes);
    const resourceStr = resource?.toString() ?? row.resource ?? undefined;

    return this.issueTokenPair(client.client_id, scopes, resourceStr);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const refreshTokenHash = hashOpaqueValue(refreshToken);

    // Atomically claim the refresh token: UPDATE WHERE revoked = 0, check changes === 1
    const claimed = this.db
      .prepare(
        "UPDATE oauth_tokens SET revoked = 1 WHERE token = ? AND token_type = 'refresh' AND revoked = 0",
      )
      .run(refreshTokenHash);

    if (claimed.changes !== 1) {
      throw new Error("Invalid refresh token");
    }

    // Now read the token data (already revoked, safe from replay)
    const row = this.db
      .prepare("SELECT * FROM oauth_tokens WHERE token = ?")
      .get(refreshTokenHash) as OAuthTokenRow | undefined;

    if (!row) {
      throw new Error("Invalid refresh token");
    }

    if (row.client_id !== client.client_id) {
      throw new Error("Refresh token was not issued to this client");
    }

    const nowSecs = Math.floor(Date.now() / 1000);
    if (row.expires_at < nowSecs) {
      throw new Error("Refresh token has expired");
    }

    const tokenScopes: string[] = scopes ?? JSON.parse(row.scopes);
    const resourceStr = resource?.toString() ?? row.resource ?? undefined;

    return this.issueTokenPair(client.client_id, tokenScopes, resourceStr);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Check legacy API key first (backward compatibility)
    // Use timing-safe comparison to prevent timing side-channel attacks
    if (this.legacyApiKeyBuf) {
      const tokenBuf = Buffer.from(token);
      if (
        tokenBuf.length === this.legacyApiKeyBuf.length &&
        timingSafeEqual(tokenBuf, this.legacyApiKeyBuf)
      ) {
        // Far-future expiry — legacy tokens don't expire
        const farFuture = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
        return {
          token,
          clientId: "legacy-bearer",
          scopes: [],
          expiresAt: farFuture,
        };
      }
    }

    // Check OAuth tokens
    const accessTokenHash = hashOpaqueValue(token);
    const row = this.db
      .prepare(
        "SELECT * FROM oauth_tokens WHERE token = ? AND token_type = 'access' AND revoked = 0",
      )
      .get(accessTokenHash) as OAuthTokenRow | undefined;

    if (!row) {
      throw new InvalidTokenError("Invalid access token");
    }

    const nowSecs = Math.floor(Date.now() / 1000);
    if (row.expires_at < nowSecs) {
      throw new InvalidTokenError("Access token has expired");
    }

    return {
      token,
      clientId: row.client_id,
      scopes: JSON.parse(row.scopes),
      expiresAt: row.expires_at,
      resource: row.resource ? new URL(row.resource) : undefined,
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const tokenHash = hashOpaqueValue(request.token);
    // Revoke the token if it belongs to this client
    this.db
      .prepare(
        "UPDATE oauth_tokens SET revoked = 1 WHERE token = ? AND client_id = ?",
      )
      .run(tokenHash, client.client_id);
  }

  /**
   * Clean up expired auth codes, revoked/expired tokens, and stale pending auths.
   * Piggybacks on the existing session sweep timer.
   */
  cleanupExpired(): { codes: number; tokens: number } {
    const nowSecs = Math.floor(Date.now() / 1000);

    const codesResult = this.db
      .prepare(
        "DELETE FROM oauth_auth_codes WHERE expires_at < ? OR used = 1",
      )
      .run(nowSecs);

    const tokensResult = this.db
      .prepare(
        "DELETE FROM oauth_tokens WHERE expires_at < ? OR revoked = 1",
      )
      .run(nowSecs);

    // Sweep expired pending authorization transactions
    for (const [nonce, pending] of this.pendingAuths) {
      if (pending.expiresAt < nowSecs) {
        this.pendingAuths.delete(nonce);
      }
    }

    return {
      codes: codesResult.changes,
      tokens: tokensResult.changes,
    };
  }

  // --- Private helpers ---

  private issueTokenPair(
    clientId: string,
    scopes: string[],
    resource?: string,
  ): OAuthTokens {
    const now = nowUTC();
    const nowSecs = Math.floor(Date.now() / 1000);

    const accessToken = randomBytes(32).toString("hex");
    const refreshToken = randomBytes(32).toString("hex");
    const accessTokenHash = hashOpaqueValue(accessToken);
    const refreshTokenHash = hashOpaqueValue(refreshToken);

    const accessExpiresAt = nowSecs + ACCESS_TOKEN_TTL;
    const refreshExpiresAt = nowSecs + REFRESH_TOKEN_TTL;

    const scopesJson = JSON.stringify(scopes);

    const txn = this.db.transaction(() => {
      // Insert refresh token first
      this.db
        .prepare(
          `INSERT INTO oauth_tokens
           (token, token_type, client_id, scopes, resource, expires_at, created_at)
           VALUES (?, 'refresh', ?, ?, ?, ?, ?)`,
        )
        .run(refreshTokenHash, clientId, scopesJson, resource ?? null, refreshExpiresAt, now);

      // Insert access token linked to refresh token
      this.db
        .prepare(
          `INSERT INTO oauth_tokens
           (token, token_type, client_id, scopes, resource, expires_at, created_at, refresh_token_ref)
           VALUES (?, 'access', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          accessTokenHash,
          clientId,
          scopesJson,
          resource ?? null,
          accessExpiresAt,
          now,
          refreshTokenHash,
        );
    });

    txn();

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL,
      scope: scopes.join(" "),
      refresh_token: refreshToken,
    };
  }
}

// --- Helpers ---

function getClientSecretWrapKey(legacyApiKey?: string): Buffer | undefined {
  const configuredKey = process.env.MUNIN_OAUTH_CLIENT_SECRET_KEY?.trim() || legacyApiKey;
  if (!configuredKey) return undefined;
  return createHash("sha256").update(configuredKey).digest();
}

function isEncryptedClientSecret(value: string): boolean {
  return value.startsWith(CLIENT_SECRET_WRAP_PREFIX);
}

function encryptClientSecret(secret: string, wrapKey?: Buffer): string {
  if (!wrapKey) {
    throw new Error(
      "Confidential OAuth clients require MUNIN_API_KEY or MUNIN_OAUTH_CLIENT_SECRET_KEY so client secrets can be encrypted at rest.",
    );
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrapKey, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    CLIENT_SECRET_WRAP_PREFIX.slice(0, -1),
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

function decryptClientSecret(storedSecret: string, wrapKey?: Buffer): string {
  if (!isEncryptedClientSecret(storedSecret)) {
    return storedSecret;
  }

  if (!wrapKey) {
    throw new Error(
      "Encrypted OAuth client secrets require MUNIN_API_KEY or MUNIN_OAUTH_CLIENT_SECRET_KEY to decrypt.",
    );
  }

  const parts = storedSecret.split(":");
  if (parts.length !== 5 || parts[0] !== "enc" || parts[1] !== "v1") {
    throw new Error("Invalid encrypted OAuth client_secret format");
  }

  const [, , ivEncoded, authTagEncoded, ciphertextEncoded] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    wrapKey,
    Buffer.from(ivEncoded, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(authTagEncoded, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

function rowToClientInfo(
  row: OAuthClientRow,
  wrapKey?: Buffer,
): OAuthClientInformationFull {
  const metadata = JSON.parse(row.metadata);
  return {
    client_id: row.client_id,
    client_secret: row.client_secret ? decryptClientSecret(row.client_secret, wrapKey) : undefined,
    client_id_issued_at: row.client_id_issued_at ?? undefined,
    client_secret_expires_at: row.client_secret_expires_at ?? undefined,
    // Return as strings, not URL objects. The SDK's authorize handler uses
    // .includes(string) for redirect_uri validation — URL objects never match.
    redirect_uris: JSON.parse(row.redirect_uris) as unknown as URL[],
    client_name: row.client_name ?? undefined,
    client_uri: row.client_uri ? new URL(row.client_uri) : undefined,
    logo_uri: row.logo_uri ? new URL(row.logo_uri) : undefined,
    scope: row.scope ?? undefined,
    token_endpoint_auth_method: row.token_endpoint_auth_method ?? undefined,
    grant_types: JSON.parse(row.grant_types),
    response_types: JSON.parse(row.response_types),
    ...metadata,
  };
}
