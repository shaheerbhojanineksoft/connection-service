import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";

import { healthController } from "./controllers/health.controller";
import { connectionController } from "./controllers/connection.controller";
import { circlesController } from "./controllers/circles.controller";

/**
 * Main application assembly (like app.js / main.ts in Node.js).
 *
 * CONVENTION — every API lives in a controller under src/controllers/:
 *   - public endpoints   → plain Elysia instance (health)
 *   - protected endpoints → wrapped with authInterceptor (connection)
 * Each controller uses ONE prefix, documents every route with Swagger
 * `detail` (tags + summary), and delegates logic to src/services/.
 */
export const app = new Elysia()
  .use(
    swagger({
      path: "/swagger",
      // Use the classic Swagger UI (like typical Node.js projects)
      // instead of the default Scalar UI.
      provider: "swagger-ui",
      documentation: {
        info: {
          title: "Connection Service",
          version: "1.0.0",
          description:
            "API documentation for the Connection Service. Swagger UI is available at /swagger and the OpenAPI JSON spec at /swagger/json.",
        },
        tags: [
          {
            name: "Health",
            description: "Service health checks",
          },
          {
            name: "Connections",
            description: "Authenticated connection endpoints (Bearer token required)",
          },
          {
            name: "Circles",
            description: "Authenticated circles endpoints (Bearer token required)",
          },
        ],
        // Make Swagger UI's "Try it out" go through the APISIX gateway
        // (the service only trusts APISIX-injected X-Userinfo, not raw JWTs).
        // AUTH MODE (env `GATEWAY_AUTH_ENABLED`):
        //   true  (default) → APISIX validates the token and injects X-Userinfo;
        //                     protected routes read that header.
        //   false           → no gateway: this service verifies the raw Bearer
        //                     token itself (Keycloak JWKS) and takes the user
        //                     from the verified claims.
        servers: [
           {
            url: "https://lapi-dev.traderverse.io/connection",
            description: "Dev gateway — Swagger UI at /authentication/swagger",
          },
          {
            url: "https://lapi.traderverse.io/connection",
            description: "Dev gateway — Swagger UI at /authentication/swagger",
          },
          {
            url: "http://localhost:9080/connection",
            description:
              "APISIX Gateway, local dev (token verified here when GATEWAY_AUTH_ENABLED=true)",
          },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
              description:
                "Keycloak access token. Click the Authorize (lock) button and paste your Bearer token.",
            },
          },
        },
      },
    })
  )
  .get("/", () => ({
    message: "Connection Service is running 🚀",
    docs: "/swagger",
    openapi: "/swagger/json",
  }))
  .use(healthController)      // public
  .use(connectionController)  // protected (openid-connect + interceptor)
  .use(circlesController);    // protected (openid-connect + interceptor)

export type App = typeof app;
