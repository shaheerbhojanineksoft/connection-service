import { Elysia } from "elysia";

/**
 * Health check endpoint (public).
 * Returns service status so orchestration / load balancers can verify it is up.
 *
 * HOW TO ADD A NEW ENDPOINT HERE:
 *   .get("/foo", () => ..., { detail: { tags: ["Health"], summary: "..." } })
 */
export const healthController = new Elysia().get(
  "/health",
  () => ({
    status: "ok",
    message: "Connection Service is running",
    timestamp: Date.now(),
  }),
  {
    detail: {
      tags: ["Health"],
      summary: "Service health check",
      description: "Returns 200 with service status when the service is up.",
    },
  }
);
