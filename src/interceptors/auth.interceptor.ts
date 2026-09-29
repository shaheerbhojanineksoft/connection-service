import { Elysia } from "elysia";

import { constants } from "../config/constants";
import { verifyKeycloakToken } from "../services/keycloak.service";

/**
 * Protected-route interceptor (macro-style) with TWO auth modes, selected by the
 * env flag `GATEWAY_AUTH_ENABLED`:
 *
 *   `true` (DEFAULT) — APISIX gateway flow (unchanged)
 *     APISIX (openid-connect plugin) verifies the Bearer token and injects the
 *     Keycloak identity in the `X-Userinfo` header. This interceptor only READS
 *     that header (base64 or plain JSON); it never verifies a token itself.
 *
 *   `false` — no gateway in front
 *     NOTHING from the headers is trusted: the raw
 *     `Authorization: Bearer <token>` is verified HERE against Keycloak's JWKS
 *     (`iss` + signature + expiry) and the identity is taken from the VERIFIED
 *     claims. `X-Userinfo` is IGNORED in this mode — trusting it would let any
 *     caller impersonate any user.
 *
 * Both modes expose the SAME context to handlers, so no downstream flow changes:
 *   - `userId`   → the Keycloak `sub` (local users are keyed by it),
 *   - `userinfo` → the token claims (or the APISIX userinfo object).
 * 401 is returned when the identity is missing/invalid.
 *
 * IMPORTANT: this must be applied to the SAME Elysia instance that defines the
 * protected routes (e.g. the controller), not via a separate `.use()` plugin —
 * in Elysia v1 a used plugin's `derive` does not propagate to parent routes.
 *
 * Usage:
 *   export const myController = authInterceptor(new Elysia({ prefix: "/x" }))
 *     .get("/me", ({ userId }) => ...);
 */

/**
 * Parse the APISIX `X-Userinfo` header.
 * APISIX's openid-connect plugin sends it as BASE64-encoded JSON of the
 * validated token claims. We also accept plain JSON for convenience/tests.
 */
function parseUserinfo(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  }
}

/** `Authorization: Bearer <token>` → token (or "" when absent/malformed). */
function parseBearerToken(raw: string | undefined): string {
  if (!raw) return "";
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() ?? "";
}

export const authInterceptor = <App extends Elysia<any>>(app: App) =>
  app.derive(async ({ headers, status }) => {
    // ---- Mode 1: APISIX already verified the token (default) ----
    if (constants.GATEWAY_AUTH_ENABLED) {
      const raw = headers["x-userinfo"];
      if (!raw) {
        return status(401, {
          error: "Missing user identity (X-Userinfo header)",
        });
      }

      try {
        const userinfo = parseUserinfo(raw);
        const userId = userinfo.sub;
        if (!userId) {
          return status(401, {
            error: "Userinfo is missing the sub (user_id) claim",
          });
        }
        // Expose the full Keycloak user info (token claims) to handlers too.
        return { userId, userinfo };
      } catch {
        return status(401, { error: "Invalid X-Userinfo header" });
      }
    }

    // ---- Mode 2: no gateway — verify the raw Keycloak token here ----
    const token = parseBearerToken(headers["authorization"]);
    if (!token) {
      return status(401, {
        error: "Missing or malformed Authorization header (Bearer token required)",
      });
    }

    try {
      const userinfo = await verifyKeycloakToken(token);
      const userId = userinfo.sub;
      if (!userId) {
        return status(401, {
          error: "Token is missing the sub (user_id) claim",
        });
      }
      return { userId, userinfo };
    } catch (error) {
      // Never tell the caller WHY it failed (expired / bad signature / issuer).
      console.error("[auth] token verification failed:", error);
      return status(401, { error: "Invalid or expired token" });
    }
  });
