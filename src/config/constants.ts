/**
 * All environment variables / constants used by the Connection Service.
 */

/** Boolean env var — accepts true/false, 1/0, yes/no, on/off; blank ⇒ fallback. */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return fallback;
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new Error(
    `[config] Environment variable must be a boolean (got "${raw}") — use true/false.`
  );
}

export const constants = {
  // --- Mongo (single DB per service convention) ---
  DATABASE_URL: process.env.DATABASE_URL ?? "mongodb://localhost:27017",
  DATABASE_NAME: process.env.DATABASE_NAME ?? "Traderverse-connections",

  // --- Auth mode (who verifies the user's token) ---
  // true  (DEFAULT, unchanged) → APISIX (openid-connect) verified the token and
  //         injects `X-Userinfo`: the protected routes only read that header.
  // false → no gateway in front: THIS service verifies the raw
  //         `Authorization: Bearer <token>` itself against Keycloak's JWKS
  //         (signature + `iss` + expiry) and takes the identity from the
  //         VERIFIED claims. `X-Userinfo` is IGNORED in this mode — trusting it
  //         would let any caller impersonate any user.
  // (Same flag/semantics as user-and-identity-service.)
  GATEWAY_AUTH_ENABLED: parseBool(process.env.GATEWAY_AUTH_ENABLED, true),
  // --- Keycloak issuer (only used when GATEWAY_AUTH_ENABLED=false) ---
  KEYCLOAK_BASE_URL: process.env.KEYCLOAK_BASE_URL ?? "",
  KEYCLOAK_REALM_NAME: process.env.KEYCLOAK_REALM_NAME ?? "",
  // Optional: explicit JWKS endpoint and extra accepted `iss` values
  // (comma separated). Blank ⇒ derived from the issuer above.
  KEYCLOAK_JWKS_URL: process.env.KEYCLOAK_JWKS_URL ?? "",
  KEYCLOAK_ISSUERS: process.env.KEYCLOAK_ISSUERS ?? "",
  // Tolerated clock skew (seconds) when verifying a Keycloak token locally.
  KEYCLOAK_CLOCK_TOLERANCE_SECONDS: Number(
    process.env.KEYCLOAK_CLOCK_TOLERANCE_SECONDS ?? 5
  ),

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
  SOCIAL_CIRCLE_DELETED_SUBJECT:
    process.env.SOCIAL_CIRCLE_DELETED_SUBJECT ?? "social.circle.deleted",
  SOCIAL_CIRCLE_MEMBER_ADDED_SUBJECT:
    process.env.SOCIAL_CIRCLE_MEMBER_ADDED_SUBJECT ?? "social.circle.member.added",
  SOCIAL_CIRCLE_MEMBER_REMOVED_SUBJECT:
    process.env.SOCIAL_CIRCLE_MEMBER_REMOVED_SUBJECT ?? "social.circle.member.removed",
} as const;
