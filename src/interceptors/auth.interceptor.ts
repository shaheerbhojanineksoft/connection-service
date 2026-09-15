import { Elysia } from "elysia";

/**
 * Protected-route interceptor (macro-style).
 *
 * APISIX (openid-connect plugin) injects the Keycloak user identity in the
 * `X-Userinfo` header. This interceptor extracts the `sub` claim
 * (= Keycloak user_id) and exposes it to handlers as `userId`. Returns 401
 * if the header is missing/invalid.
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

export const authInterceptor = <App extends Elysia<any>>(app: App) =>
  app.derive(({ headers, status }) => {
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
  });
