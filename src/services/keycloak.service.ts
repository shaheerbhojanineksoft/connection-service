import { createRemoteJWKSet, jwtVerify } from "jose";

import { constants } from "../config/constants";

/* ------------------------------------------------------------------ */
/* Direct token verification (GATEWAY_AUTH_ENABLED=false)              */
/* ------------------------------------------------------------------ */

/** Keycloak issuer = {base}/realms/{realm} (with trailing-slash safety). */
export function getIssuer(): string {
  const base = constants.KEYCLOAK_BASE_URL;
  return `${base.endsWith("/") ? base : base + "/"}realms/${constants.KEYCLOAK_REALM_NAME}`;
}

/** JWKS used to verify a raw Keycloak access token. */
function getJwksUrl(): string {
  return (
    constants.KEYCLOAK_JWKS_URL || `${getIssuer()}/protocol/openid-connect/certs`
  );
}

/** Accepted `iss` values — `KEYCLOAK_ISSUERS` (comma separated) or the issuer. */
function getValidIssuers(): string[] {
  const raw = constants.KEYCLOAK_ISSUERS;
  const list = raw
    ? raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  return list.length > 0 ? list : [getIssuer()];
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Lazily create (and cache) the remote JWKS resolver. */
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) jwks = createRemoteJWKSet(new URL(getJwksUrl()));
  return jwks;
}

/**
 * Verify a Keycloak access token LOCALLY (signature via JWKS + `iss` + expiry)
 * and return its claims. Throws when the token is invalid/expired or the
 * issuer does not match — callers translate that into a 401.
 *
 * Used only when `GATEWAY_AUTH_ENABLED` is false (no APISIX in front).
 */
export async function verifyKeycloakToken(
  token: string
): Promise<Record<string, any>> {
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: getValidIssuers(),
    clockTolerance: constants.KEYCLOAK_CLOCK_TOLERANCE_SECONDS, // seconds
  });
  return payload as Record<string, any>;
}
