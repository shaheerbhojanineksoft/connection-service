/**
 * All environment variables / constants used by the Connection Service.
 */
export const constants = {
  // --- Mongo (single DB per service convention) ---
  DATABASE_URL: process.env.DATABASE_URL ?? "mongodb://localhost:27017",
  DATABASE_NAME: process.env.DATABASE_NAME ?? "Traderverse-connections",

  // --- User-service (POST /connections/remove) ---
  USER_SERVICE_HOST: process.env.USER_SERVICE_HOST ?? "",
  USER_SERVICE_PORT: process.env.USER_SERVICE_PORT ?? "",

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
} as const;
