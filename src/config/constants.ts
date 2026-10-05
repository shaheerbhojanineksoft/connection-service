/**
 * All environment variables / constants used by the Connection Service.
 */

/* ------------------------------------------------------------------ */
/* Env readers — the ONLY place `process.env` is touched.              */
/* (Same helpers/wording as user-and-identity-service.)                */
/* ------------------------------------------------------------------ */

/** String env var, trimmed. Missing/blank -> `fallback` (structural, not config). */
function str(key: string, fallback = ""): string {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  return value === "" ? fallback : value;
}

/** Required string — throws when missing or blank. */
function reqStr(key: string): string {
  const value = str(key);
  if (value === "") {
    throw new Error(
      `[config] Missing required environment variable "${key}" (see .env.example).`
    );
  }
  return value;
}

/** Required integer — throws when missing, blank or not an integer. */
function reqInt(key: string): number {
  const raw = reqStr(key);
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(
      `[config] Environment variable "${key}" must be an integer (got "${raw}").`
    );
  }
  return value;
}

/** Required boolean — accepts true/false, 1/0, yes/no, on/off. */
function reqBool(key: string): boolean {
  const raw = reqStr(key).toLowerCase();
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  throw new Error(
    `[config] Environment variable "${key}" must be a boolean (got "${raw}").`
  );
}

export const constants = {
  // --- Mongo (single DB per service convention) ---
  DATABASE_URL: process.env.DATABASE_URL ?? "mongodb://localhost:27017",
  DATABASE_NAME: process.env.DATABASE_NAME ?? "Traderverse-connections",

  // --- Keycloak (issuer) — SAME keys as user-and-identity-service ---
  KEYCLOAK_BASE_URL: reqStr("KEYCLOAK_BASE_URL"),
  KEYCLOAK_REALM_NAME: reqStr("KEYCLOAK_REALM_NAME"),
  // Tolerated clock skew (seconds) when verifying a Keycloak token locally.
  KEYCLOAK_CLOCK_TOLERANCE_SECONDS: reqInt("KEYCLOAK_CLOCK_TOLERANCE_SECONDS"),

  // --- Auth mode (who verifies the user's token) ---
  // true  → APISIX verified the token and injects `X-Userinfo`:
  //         the protected routes read that header.
  // false → no gateway in front: THIS service verifies the raw
  //         `Authorization: Bearer <token>` itself against Keycloak's JWKS and
  //         takes the identity from the VERIFIED claims. `X-Userinfo` is
  //         ignored completely in this mode.
  GATEWAY_AUTH_ENABLED: reqBool("GATEWAY_AUTH_ENABLED"),
  // Optional override for direct-token mode (blank ⇒ derived from the issuer).
  KEYCLOAK_JWKS_URL: str("KEYCLOAK_JWKS_URL"),
  // Comma separated accepted `iss` values; blank ⇒ the configured issuer only.
  KEYCLOAK_ISSUERS: str("KEYCLOAK_ISSUERS"),

  // --- NATS: social graph events (per feed-data-sync-service contract) ---
  // Same local cluster as user-and-identity-service; anonymous connect is
  // rejected (auth callout), so the dev user auth/auth is used as default.
  NATS_URL: process.env.NATS_URL ?? "nats://localhost:4222",
  NATS_USER: process.env.NATS_USER ?? "auth",
  NATS_PASSWORD: process.env.NATS_PASSWORD ?? "auth",
  SOCIAL_STREAM: "SOCIAL",
  SOCIAL_FOLLOWED_SUBJECT: process.env.SOCIAL_FOLLOWED_SUBJECT ?? "social.followed",
  SOCIAL_UNFOLLOWED_SUBJECT: process.env.SOCIAL_UNFOLLOWED_SUBJECT ?? "social.unfollowed",
  SOCIAL_BLOCKED_SUBJECT: process.env.SOCIAL_BLOCKED_SUBJECT ?? "social.blocked",
  SOCIAL_UNBLOCKED_SUBJECT: process.env.SOCIAL_UNBLOCKED_SUBJECT ?? "social.unblocked",
  SOCIAL_CIRCLE_CREATED_SUBJECT:
    process.env.SOCIAL_CIRCLE_CREATED_SUBJECT ?? "social.circle.created",
  SOCIAL_CIRCLE_UPDATED_SUBJECT:
    process.env.SOCIAL_CIRCLE_UPDATED_SUBJECT ?? "social.circle.updated",
  SOCIAL_CIRCLE_DELETED_SUBJECT:
    process.env.SOCIAL_CIRCLE_DELETED_SUBJECT ?? "social.circle.deleted",
  SOCIAL_CIRCLE_MEMBER_ADDED_SUBJECT:
    process.env.SOCIAL_CIRCLE_MEMBER_ADDED_SUBJECT ?? "social.circle.member.added",
  SOCIAL_CIRCLE_MEMBER_REMOVED_SUBJECT:
    process.env.SOCIAL_CIRCLE_MEMBER_REMOVED_SUBJECT ?? "social.circle.member.removed",

  // --- NATS: connection-notification jobs ("Connections Notifications — Producer
  // Contract"). The JetStream stream + durable are OWNED BY THE NOTIFICATION
  // WORKER — this service only publishes into them and never creates/updates the
  // stream. Keep both values in sync with the worker's env of the same name.
  CONNECTIONS_NATS_SUBJECT:
    process.env.CONNECTIONS_NATS_SUBJECT ?? "connections.notification.jobs",
  CONNECTIONS_NATS_STREAM:
    process.env.CONNECTIONS_NATS_STREAM ?? "CONNECTIONS_NOTIFICATION",
} as const;
