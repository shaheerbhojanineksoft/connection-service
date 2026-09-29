import { Elysia, t } from "elysia";

import { authInterceptor } from "../interceptors/auth.interceptor";
import type { AddConnectionDTO } from "../dto/add-connection.dto";
import type { CancelRequestDTO } from "../dto/cancel-request.dto";
import {
  addConnection,
  blockUser,
  blockedUsersListing,
  cancelRequest,
  getConnections,
  getConnectionsSummary,
  getUserPhotos,
  removeFriend,
  unblockUser,
  unfollow,
  updateConnectionStatus,
  userFriendsAndFollowingCount,
} from "../services/connection.service";

/**
 * NestJS/class-validator style 400 body (matches the integration contract).
 * Message order: "must be a string" first, then "should not be empty".
 */
function validateBlockedId(body: unknown): string[] {
  const raw = (body as { blockedId?: unknown } | undefined)?.blockedId;
  const messages: string[] = [];
  if (typeof raw !== "string") messages.push("blockedId must be a string");
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.length === 0)) {
    messages.push("blockedId should not be empty");
  }
  return messages;
}

const BAD_REQUEST = { error: "Bad Request" as const };

/**
 * Normalise the `userIds` field of `POST /connectionssummary`.
 *
 * The payload MUST always be an ARRAY OF STRINGS — one id (`["u1"]`) or many
 * (`["u1","u2"]`) — but at least ONE non-empty entry is required.
 *
 * The route schema already enforces the array-of-strings SHAPE (a wrong shape is
 * rewritten to this same 400 body by the `onError` hook below), so this helper
 * only covers the cases the schema cannot: missing/empty array and blank ids.
 */
function normalizeUserIds(body: unknown): { ids: string[]; messages: string[] } {
  const raw = (body as { userIds?: unknown } | undefined)?.userIds;

  // missing / null
  if (raw === undefined || raw === null) {
    return { ids: [], messages: ["userIds should not be empty"] };
  }

  if (!Array.isArray(raw)) {
    return { ids: [], messages: ["userIds must be an array of strings"] };
  }
  if (raw.length === 0) {
    return { ids: [], messages: ["userIds should not be empty"] };
  }

  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return { ids: [], messages: ["each userId must be a non-empty string"] };
    }
    ids.push(item.trim());
  }
  return { ids, messages: [] };
}

/**
 * Swagger dummy values for `POST /connectionssummary` (documentation only).
 *
 * ⚠️ Used via `example` — NEVER via `default`: Elysia APPLIES a TypeBox
 * `default` to the parsed body, which would silently invent ids for a request
 * that sent none and bypass the "userIds should not be empty" 400.
 */
const CONNECTIONS_SUMMARY_USER_IDS_EXAMPLE = [
  "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "9c858901-8a57-4791-81fe-4c455b099bc9",
];

/**
 * Protected connection endpoints (Bearer token → APISIX injects X-Userinfo).
 * `authInterceptor` makes `userId` available to every handler and rejects
 * with 401 when the identity header is missing/invalid.
 *
 * NOTE: APISIX strips the `/connection` prefix, so routes here are registered
 * WITHOUT that prefix (e.g. `/blockedusers` → gateway `/connection/blockedusers`).
 *
 * HOW TO ADD A PROTECTED ENDPOINT HERE:
 *   .get("/friends", async ({ userId }) => ...,
 *        { detail: { tags: ["Connections"], summary: "...", security: [{ bearerAuth: [] }] } })
 */
export const connectionController = authInterceptor(new Elysia())
  /**
   * `POST /connectionssummary` is the ONLY route here with a strict body schema,
   * so a wrong payload shape would otherwise leak Elysia's raw 422. Rewrite that
   * ONE failure into the house NestJS-style 400. Every other route/error falls
   * through UNCHANGED (returning `undefined` keeps Elysia's default handling).
   */
  .onError(({ code, path, body, set }) => {
    if (code === "VALIDATION" && String(path ?? "").endsWith("/connectionssummary")) {
      const raw = (body as { userIds?: unknown } | undefined)?.userIds;
      set.status = 400;
      return {
        statusCode: 400,
        message: [
          raw === undefined || raw === null
            ? "userIds should not be empty" // absent / null — same wording as `{}`
            : "userIds must be an array of strings", // wrong shape (string / number / …)
        ],
        ...BAD_REQUEST,
      };
    }
    return undefined;
  })
  .get(
    "/blockedusers",
    async ({ userId }) => {
      // No logic here — just call the service and return its response.
      return await blockedUsersListing(userId);
    },
    {
      detail: {
        tags: ["Connections"],
        summary: "Get the current user's blocked users",
        description:
          "Returns the current user's blocked users (paginated, sorted by followers, " +
          "enriched with connection counts + relationship flags).",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .get(
    "/photos/:id",
    async ({ params, userId }) => {
      // No logic here — just call the service and return its response.
      return await getUserPhotos(params.id, userId);
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Connections"],
        summary: "Get a user's photos (privacy-gated)",
        description:
          "Returns the photo list of a user gated by privacy settings " +
          "(owner / blocked / relation / circles checks).",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .get(
    "/connectionscount",
    async ({ userId }) => {
      // No logic here — just call the service and return its response.
      return await userFriendsAndFollowingCount(userId);
    },
    {
      detail: {
        tags: ["Connections"],
        summary: "Get the current user's friends & following counts",
        description:
          "Returns friendsCount and followingCount, excluding connections to " +
          "blocked (either direction) or deleted users.",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .post(
    "/unfollow",
    async ({ body, set, userId }) => {
      const connectionId = (body as any)?.connectionId;
      if (typeof connectionId !== "string" || connectionId.trim().length === 0) {
        set.status = 400;
        return {
          statusCode: 400,
          message: ["connectionId should not be empty"],
          error: "Bad Request",
        };
      }
      // No logic here — just call the service and return its response.
      return await unfollow(userId, connectionId);
    },
    {
      body: t.Object(
        { connectionId: t.Optional(t.String()) },
        { additionalProperties: true }
      ),
      detail: {
        tags: ["Connections"],
        summary: "Unfollow a user",
        description:
          "Removes the following connection and recomputes cached counts for both " +
          "users.",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .post(
    "/addConnection",
    async ({ body, userId }) => {
      // No ValidationPipe in the source: a missing body behaves like `{}` and lands
      // on the handler's default branch ("Invalid Request Type") — never a 422/500.
      // ⚠️ The cast is deliberate: `AddConnectionDTO` types connectionId/requestType
      // as required, but the source route validates nothing.
      const payload = {
        ...(body as AddConnectionDTO | undefined),
        userId, // userId hamesha auth se (body ka ignore)
      } as AddConnectionDTO;
      // No logic here — just call the service and return its response.
      return await addConnection(payload);
    },
    {
      body: t.Optional(
        t.Object(
          {
            connectionId: t.Optional(t.String()),
            requestType: t.Optional(t.String()),
            relationType: t.Optional(t.String()),
            preApprovedPlan: t.Optional(t.Boolean()),
            hideNotification: t.Optional(t.Boolean()),
          },
          { additionalProperties: true }
        )
      ),
      detail: {
        tags: ["Connections"],
        summary: "Add a connection (friend / follow request / following)",
        description:
          "Creates a friendrequest / followrequest / following connection with " +
          "duplicate guards, profile checks, and count updates.",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .get(
    "/connections",
    async ({ query, userId }) => {
      const q = query as Record<string, string | undefined>;
      const connectionType = q.connectionType ?? "all";
      const targetUserId = q.userId || userId; // default to authenticated user
      // No logic here — just call the service and return its response.
      return await getConnections({
        connectionType,
        userId: targetUserId,
        authenticatedUserId: userId,
      });
    },
    {
      query: t.Object(
        {
          connectionType: t.Optional(t.String()),
          userId: t.Optional(t.String()),
        },
        { additionalProperties: true }
      ),
      detail: {
        tags: ["Connections"],
        summary: "Get connections (requests / invited / following / followers / friends / all)",
        description:
          "Read-only list of connections built via aggregation, dedup, and friend filter.",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .post(
    "/block",
    async ({ body, set, userId }) => {
      const messages = validateBlockedId(body);
      if (messages.length) {
        set.status = 400;
        return { statusCode: 400, message: messages, ...BAD_REQUEST };
      }
      // userId always from the token — a body `userId` is ignored/replaced.
      const result = await blockUser(userId, (body as { blockedId: string }).blockedId);
      set.status = 201; // NestJS default for POST (service failures also return 201)
      return result;
    },
    {
      body: t.Optional(
        t.Object(
          {
            blockedId: t.Optional(t.Any()),
            userId: t.Optional(t.Any()),
          },
          { additionalProperties: true }
        )
      ),
      detail: {
        tags: ["Connections"],
        summary: "Block a user",
        description:
          "Blocks the user identified by `blockedId` (the blocker comes from the " +
          "access token). Creates a `blocked` document, removes connections in " +
          "both directions, and recomputes cached counts for both users.",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .post(
    "/unblock",
    async ({ body, set, userId }) => {
      const messages = validateBlockedId(body);
      if (messages.length) {
        set.status = 400;
        return { statusCode: 400, message: messages, ...BAD_REQUEST };
      }
      // userId always from the token — a body `userId` is ignored/replaced.
      const result = await unblockUser(userId, (body as { blockedId: string }).blockedId);
      set.status = 201;
      return result;
    },
    {
      body: t.Optional(
        t.Object(
          {
            blockedId: t.Optional(t.Any()),
            userId: t.Optional(t.Any()),
          },
          { additionalProperties: true }
        )
      ),
      detail: {
        tags: ["Connections"],
        summary: "Unblock a user",
        description:
          "Removes the block edge owned by the current user for `blockedId` and " +
          "recomputes cached counts for both users.",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .post(
    "/cancelrequest",
    async ({ body, set, userId }) => {
      // The source route has NO ValidationPipe: a missing body behaves like `{}`
      // (NestJS) and simply finds no request — never a 400/422/500.
      // userId always from the token — a body `userId` is ignored/replaced.
      const payload: CancelRequestDTO = {
        ...(body as CancelRequestDTO | undefined),
        userId,
      };
      // No logic here — just call the service and return its response.
      const result = await cancelRequest(userId, payload);
      set.status = 201; // NestJS default for POST (not-found/error also return 201)
      return result;
    },
    {
      body: t.Optional(
        t.Object(
          {
            connectionId: t.Optional(t.Any()),
            requestType: t.Optional(t.Any()),
            userId: t.Optional(t.Any()),
          },
          { additionalProperties: true }
        )
      ),
      detail: {
        tags: ["Connections"],
        summary: "Cancel a pending connection request",
        description:
          "Finds ONE pending request (`connections` collection: userId + " +
          "connectionId + requestType + requestStatus 'pending') and deletes ALL " +
          "matching documents, returning the `_id` of the request found. The " +
          "source route has no validation: an unknown `requestType` just results " +
          "in 'No Request Found.' No notification/Firebase/user-service calls.",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .post(
    "/removefriend",
    async ({ body, set, userId }) => {
      // Body is optional (the source route has no ValidationPipe): a missing body
      // behaves like `{}`. `requestType` is accepted but UNUSED by the logic.
      const payload: CancelRequestDTO = {
        ...(body as CancelRequestDTO | undefined),
        userId, // always from the token
      };
      // No logic here — just call the service and return its response.
      const result = await removeFriend(userId, payload);
      set.status = 201; // NestJS default for POST (errors also return 201)
      return result;
    },
    {
      body: t.Optional(
        t.Object(
          {
            connectionId: t.Optional(t.Any()),
            requestType: t.Optional(t.Any()),
            userId: t.Optional(t.Any()),
          },
          { additionalProperties: true }
        )
      ),
      detail: {
        tags: ["Connections"],
        summary: "Remove a friend",
        description:
          "Mongo-only: deletes the `friends` connections in BOTH directions, " +
          "recomputes the cached counts for both users (excluding blocked and " +
          "deleted users), then deletes the current user's `topfriends` entry. " +
          "No user-service / notification / Firebase / queue work.",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .post(
    "/connectionssummary",
    async ({ body, set, userId }) => {
      // Payload is ALWAYS an array of strings (one id or many); minimum ONE id.
      const { ids, messages } = normalizeUserIds(body);
      if (messages.length) {
        set.status = 400;
        return { statusCode: 400, message: messages, ...BAD_REQUEST };
      }
      // Read-only query → HTTP 200. userId always from the token.
      const result = await getConnectionsSummary(userId, ids);
      set.status = 200;
      return result;
    },
    {
      body: t.Optional(
        t.Object(
          {
            // `userIds` is ALWAYS an array of strings (1..n) — never a bare string.
            // NOTE: `example`/`examples` are documentation only; do NOT add a
            // `default` (Elysia would inject it into the parsed body).
            userIds: t.Optional(
              t.Array(
                t.String(),
                {
                  example: CONNECTIONS_SUMMARY_USER_IDS_EXAMPLE,
                  examples: [CONNECTIONS_SUMMARY_USER_IDS_EXAMPLE],
                  description:
                    "One or many user ids (MUST be an array of strings; " +
                    "at least one non-empty id required).",
                } as any
              )
            ),
          },
          { additionalProperties: true }
        )
      ),
      detail: {
        tags: ["Connections"],
        summary: "Batch relation summary for one or many user ids",
        description:
          "Read-only. For every id sent in the `userIds` ARRAY (one id or many, " +
          "minimum one required) returns the relation with the authenticated " +
          "user: isFriend, isFollowing (me→them), isFollowedBy (them→me), " +
          "isRequestSent / isRequestReceived (pending friendrequest), " +
          "isFollowRequestSent / isFollowRequestReceived (pending followrequest), " +
          "isBlocked / isBlockedBy, a derived `relation` string, and the raw " +
          "pending request docs (`_id` needed to accept/reject/cancel). " +
          "All flags are relative to the token user. No writes, no external " +
          "service calls.",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .put(
    "/:id/status/:status",
    async ({ params, userId }) => {
      // `notificationId` in the body is accepted and IGNORED (notification work removed).
      // userId comes from the token; :id is the connection REQUEST document _id.
      return await updateConnectionStatus(params.id, params.status, userId);
    },
    {
      params: t.Object({ id: t.String(), status: t.String() }),
      body: t.Optional(
        t.Object(
          { notificationId: t.Optional(t.Any()) },
          { additionalProperties: true }
        )
      ),
      detail: {
        tags: ["Connections"],
        summary: "Accept or reject a connection request",
        description:
          "Mongo-only. `accept`: `friendrequest` also ensures the friends + " +
          "following edges in both directions; `followrequest` only sets the " +
          "status. Both recompute the cached counts. `reject`: only sets " +
          "`requestStatus`. Any other status returns 'Invald Request Type'. " +
          "No notification/Firebase/user-service/queue work.",
        security: [{ bearerAuth: [] }],
      },
    }
  );
