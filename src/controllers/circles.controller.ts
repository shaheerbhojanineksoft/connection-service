import { Elysia, t } from "elysia";

import { authInterceptor } from "../interceptors/auth.interceptor";
import type {
  AddCircleDTO,
  AddRemoveCircleMemberDTO,
  EditCircleDTO,
} from "../dto/circle.dto";
import {
  addCircle,
  addCircleMember,
  deleteCircleById,
  editCircle,
  getCircleById,
  getCirclesByUserId,
  getConnectionsForCircle,
  removeCircleMember,
  validateCircleName,
} from "../services/circles.service";

/**
 * Protected Circles endpoints (Bearer token → APISIX injects X-Userinfo).
 *
 * REST base path from webapi-blueorbit is `/api/circles`; here the routes are
 * registered WITHOUT a prefix (APISIX strips `/connection`), so the gateway
 * paths are `/connection/circles...` — mirroring `/connection/blockedusers`.
 *
 * ROUTE ORDER MATTERS: `GET /circles/connections` is declared BEFORE
 * `GET /circles/:id` so `connections` is never captured as an id.
 */

/** NestJS `ParseIntPipe` failure shape (query params page/count). */
function parseNumericQuery(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

const NUMERIC_QUERY_MESSAGE = "Validation failed (numeric string is expected)";

export const circlesController = authInterceptor(new Elysia())
  // NOTE: must stay above `GET /circles/:id`
  .get(
    "/circles/connections",
    async ({ query, set, userId }) => {
      const q = query as Record<string, string | undefined>;
      const page = parseNumericQuery(q.page, 1);
      const count = parseNumericQuery(q.count, 10);
      if (page === null || count === null) {
        set.status = 400;
        return { statusCode: 400, message: NUMERIC_QUERY_MESSAGE, error: "Bad Request" };
      }
      // `id` is accepted but unused (contract §4.2 / §6.5).
      return await getConnectionsForCircle(userId, q.id ?? "", page, count);
    },
    {
      query: t.Object(
        {
          id: t.Optional(t.String()),
          page: t.Optional(t.String()),
          count: t.Optional(t.String()),
        },
        { additionalProperties: true }
      ),
      detail: {
        tags: ["Circles"],
        summary: "Get connections + the circles they belong to",
        description:
          "Lists the current user's friends/following connections (paginated). Each " +
          "entry FLAT-merges the full `POST /connectionssummary` relation object " +
          "(isFriend, isFollowing, isFollowedBy, isRequestSent / isRequestReceived, " +
          "isFollowRequestSent / isFollowRequestReceived, isBlocked / isBlockedBy, " +
          "`relation` and the raw pending request docs) with that connection's " +
          "`user` and the active circles of the user that contain them. `id` is " +
          "accepted but unused.",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .get(
    "/circles/validate/:name",
    async ({ params, userId }) => {
      return await validateCircleName(userId, params.name);
    },
    {
      params: t.Object({ name: t.String() }),
      detail: {
        tags: ["Circles"],
        summary: "Check circle name availability",
        description:
          "Case-insensitive name check scoped to the current user and active circles.",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .get(
    "/circles",
    async ({ query, set, userId }) => {
      const q = query as Record<string, string | undefined>;
      const page = parseNumericQuery(q.page, 1);
      const count = parseNumericQuery(q.count, 10);
      if (page === null || count === null) {
        set.status = 400;
        return { statusCode: 400, message: NUMERIC_QUERY_MESSAGE, error: "Bad Request" };
      }
      return await getCirclesByUserId(userId, page, count);
    },
    {
      query: t.Object(
        {
          page: t.Optional(t.String()),
          count: t.Optional(t.String()),
        },
        { additionalProperties: true }
      ),
      detail: {
        tags: ["Circles"],
        summary: "Get the current user's circles",
        description:
          "Returns the current user's active circles (createdOn desc, paginated) " +
          "with members enriched in one batch. Every member's relation flags " +
          "(isFriend, isFollowing, isFollowedBy, isRequestSent / isRequestReceived, " +
          "isFollowRequestSent / isFollowRequestReceived, isBlocked / isBlockedBy) " +
          "are RECOMPUTED against the authenticated user — the raw user documents " +
          "otherwise carry stale snapshots (e.g. `isFollowing: false` for someone " +
          "you follow).",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .get(
    "/circles/:id",
    async ({ params, userId }) => {
      return await getCircleById(params.id, userId);
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Circles"],
        summary: "Get a circle by id",
        description:
          "Owner-only lookup; returns the raw circle document with each member's " +
          "relation flags recomputed against the authenticated user.",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .post(
    "/circles",
    async ({ body, set, userId }) => {
      // No ValidationPipe in the source: a missing body behaves like `{}` and the
      // service answers "Invalid input data" — never a 500.
      const payload: AddCircleDTO = {
        ...(body as AddCircleDTO | undefined),
        createdBy: userId, // always from the token
      };
      const result = await addCircle(payload);
      set.status = 201; // NestJS default for POST (business errors still 201)
      return result;
    },
    {
      body: t.Optional(
        t.Object(
          {
            name: t.Optional(t.Any()),
            hexColor: t.Optional(t.Any()),
            memberIds: t.Optional(t.Any()),
          },
          { additionalProperties: true }
        )
      ),
      detail: {
        tags: ["Circles"],
        summary: "Create a circle",
        description:
          "Creates a circle (uuid v4 id) with optional seeded members.",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .put(
    "/circles/:id",
    async ({ body, params, userId }) => {
      const payload: EditCircleDTO = {
        ...(body as EditCircleDTO | undefined),
        circleId: params.id,
        userId,
      };
      return await editCircle(payload);
    },
    {
      body: t.Optional(
        t.Object(
          {
            name: t.Optional(t.Any()),
            hexColor: t.Optional(t.Any()),
          },
          { additionalProperties: true }
        )
      ),
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Circles"],
        summary: "Edit a circle",
        description: "Owner-only update of `name` + `hexColor`.",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .delete(
    "/circles/:id",
    async ({ params, userId }) => {
      return await deleteCircleById(params.id, userId);
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Circles"],
        summary: "Delete a circle (soft delete)",
        description: "Owner-only soft delete (`isDeleted: true`).",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .post(
    "/circles/:id/addmember",
    async ({ body, params, set, userId }) => {
      const payload: AddRemoveCircleMemberDTO = {
        ...(body as AddRemoveCircleMemberDTO | undefined),
        circleId: params.id,
        userId,
      };
      const result = await addCircleMember(payload);
      set.status = 201;
      return result;
    },
    {
      body: t.Optional(
        t.Object(
          { memberIds: t.Optional(t.Any()) },
          { additionalProperties: true }
        )
      ),
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Circles"],
        summary: "Add members to a circle",
        description: "Owner-only append of new members (dedup by _id).",
        security: [{ bearerAuth: [] }],
      },
    }
  )
  .put(
    "/circles/:id/removemember",
    async ({ body, params, userId }) => {
      const payload: AddRemoveCircleMemberDTO = {
        ...(body as AddRemoveCircleMemberDTO | undefined),
        circleId: params.id,
        userId,
      };
      return await removeCircleMember(payload);
    },
    {
      body: t.Optional(
        t.Object(
          { memberIds: t.Optional(t.Any()) },
          { additionalProperties: true }
        )
      ),
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Circles"],
        summary: "Remove members from a circle",
        description: "Owner-only removal of the given member ids.",
        security: [{ bearerAuth: [] }],
      },
    }
  );
