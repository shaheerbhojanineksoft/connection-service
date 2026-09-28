/**
 * Circles Feature — business logic (per "Circles API – Integration Contract").
 *
 * Drop-in equivalent of the `Socialmedia-Microservice` `{ cmd: "..." }` handlers,
 * implemented ALL-IN-ONE as direct Mongo against this service's own DB
 * (`circles`, `connections`, `users`) — no TCP hop.
 *
 * ⚠️ Payloads, response envelopes, messages and HTTP behaviour are preserved
 * EXACTLY as documented (including the duplicate-name caveat §6.1).
 */
import { constants } from "../config/constants";
import type {
  AddCircleDTO,
  AddRemoveCircleMemberDTO,
  EditCircleDTO,
} from "../dto/circle.dto";
import {
  findCircles,
  findOneCircle,
  insertCircle,
  updateCircle,
} from "../repositories/circles.repo";
import { findConnectionsPaged } from "../repositories/connections.repo";
import { findManyUsers } from "../repositories/users.repo";
import type { Circle, ResponseModel } from "../types/circle.types";
import {
  publishSocialCircleCreated,
  publishSocialCircleDeleted,
  publishSocialCircleMemberAdded,
  publishSocialCircleMemberRemoved,
} from "./nats.publisher";

/** User Service base URL — side effects are best-effort (never change the response). */
const USER_SERVICE_URL = `http://${constants.USER_SERVICE_HOST}:${constants.USER_SERVICE_PORT}`;

/* ------------------------------------------------------------------ */
/* Envelope helpers (field order: isSuccess, data, message)            */
/* ------------------------------------------------------------------ */

function ok<T>(data: T, message: string): ResponseModel<T> {
  return { isSuccess: true, data, message };
}

function fail(message: string, data: unknown = null): ResponseModel<any> {
  return { isSuccess: false, data, message };
}

/** Generic internal-error envelope (§4 common: "Something went wrong"). */
function genericError(): ResponseModel<any> {
  return fail("Something went wrong");
}

/** Never persist/return credentials stored on raw user documents. */
function sanitizeUser(user: Record<string, any>): Record<string, any> {
  const copy = { ...user };
  delete copy.password;
  return copy;
}

/* ------------------------------------------------------------------ */
/* User Service side effects (fire-and-forget except deleteCircle)     */
/* ------------------------------------------------------------------ */

async function userServicePost(path: string, body: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${USER_SERVICE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    console.log(`[circles] POST ${path} → ${res.status}`);
  } catch (err) {
    console.error(`[circles] POST ${path} failed:`, err instanceof Error ? err.message : err);
  }
}

async function userServiceDelete(
  path: string,
  body?: Record<string, unknown>
): Promise<void> {
  try {
    const res = await fetch(`${USER_SERVICE_URL}${path}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    console.log(`[circles] DELETE ${path} → ${res.status}`);
  } catch (err) {
    console.error(`[circles] DELETE ${path} failed:`, err instanceof Error ? err.message : err);
  }
}

/* ------------------------------------------------------------------ */
/* GET /circles — getCirclesByUserId                                   */
/* ------------------------------------------------------------------ */

/**
 * Business logic for `GET /circles` (TCP `getCirclesByUserId`).
 * - query `{ userId, isDeleted: { $ne: true } }`, sort createdOn desc, paginated.
 * - member ids enriched in one batch via `users`; when users are returned each
 *   circle's `members` array is rebuilt from them, otherwise kept as stored.
 */
export async function getCirclesByUserId(
  userId: string,
  page = 1,
  count = 10
): Promise<ResponseModel> {
  try {
    const skip = (page - 1) * count;
    const circles = await findCircles(
      { userId, isDeleted: { $ne: true } },
      { sort: { createdOn: -1 }, skip, limit: count }
    );

    // Collect member ids across ALL circles, then enrich in ONE batch.
    const memberIds = [
      ...new Set(
        circles.flatMap((c: any) =>
          Array.isArray(c.members) ? c.members.map((m: any) => String(m._id)) : []
        )
      ),
    ];

    if (memberIds.length) {
      const users = await findManyUsers({ _id: { $in: memberIds } });
      if (users.length) {
        const userMap = new Map(users.map((u: any) => [String(u._id), sanitizeUser(u)]));
        for (const circle of circles) {
          if (!Array.isArray(circle.members)) continue;
          circle.members = circle.members
            .map((m: any) => userMap.get(String(m._id)))
            .filter(Boolean);
        }
      }
    }

    return ok(circles, "Circles found");
  } catch {
    return genericError();
  }
}

/* ------------------------------------------------------------------ */
/* GET /circles/connections — getConnectionsForCircle                  */
/* ------------------------------------------------------------------ */

/**
 * Business logic for `GET /circles/connections` (TCP `getConnectionsForCircle`).
 * ⚠️ `circleId` is accepted but NOT used in the query (§6.5) — connections come
 * purely from the current user.
 */
export async function getConnectionsForCircle(
  userId: string,
  circleId: string,
  page = 1,
  count = 10
): Promise<ResponseModel> {
  try {
    void circleId; // accepted for payload parity — filtering intentionally unused
    const skip = (page - 1) * count;

    // 1. my friends/following edges (paginated, newest first).
    const connections = await findConnectionsPaged(
      { connectionId: userId, requestType: { $in: ["friends", "following"] } },
      { sort: { createdOn: -1 }, skip, limit: count }
    );

    // 2. distinct other-user ids.
    const foundConnectionIds = [
      ...new Set(connections.map((c: any) => String(c.userId))),
    ];

    // 3. active circles of the current user containing any of those users.
    const circles = foundConnectionIds.length
      ? await findCircles(
          { isDeleted: false, userId, "members._id": { $in: foundConnectionIds } },
          { sort: { createdOn: -1 } }
        )
      : [];

    // 4. user docs — keep ONLY _id, fullName, profilePicture.
    const users = foundConnectionIds.length
      ? await findManyUsers({ _id: { $in: foundConnectionIds } })
      : [];
    const slimUsers = users.map((u: any) => ({
      _id: u._id,
      fullName: u.fullName,
      profilePicture: u.profilePicture,
    }));

    // 5. one entry per connection: { user, circles }.
    const data = connections.map((conn: any) => {
      const connId = String(conn.userId);
      const user = slimUsers.find((u: any) => String(u._id) === connId);
      const circleList = circles
        .filter(
          (c: any) =>
            Array.isArray(c.members) &&
            c.members.some((m: any) => String(m._id) === connId)
        )
        .map((c: any) => ({
          hexColor: c.hexColor,
          name: c.name,
          _id: c._id,
          createdOn: c.createdOn,
        }));
      return { user, circles: circleList };
    });

    return ok(data, "Connections Found");
  } catch {
    return genericError();
  }
}

/* ------------------------------------------------------------------ */
/* GET /circles/:id — getCircleById                                    */
/* ------------------------------------------------------------------ */

/** Business logic for `GET /circles/:id` (TCP `getCircleById`). */
export async function getCircleById(
  circleId: string,
  userId: string
): Promise<ResponseModel> {
  try {
    const circle = await findOneCircle({ _id: circleId });
    if (!circle || circle.isDeleted === true) return fail("Circle not found");
    if (circle.userId !== userId) return fail("You are not authorized");
    return ok(circle, "Circle found");
  } catch {
    return genericError();
  }
}

/* ------------------------------------------------------------------ */
/* POST /circles — addCircle                                           */
/* ------------------------------------------------------------------ */

/** Business logic for `POST /circles` (TCP `addCircle`). */
export async function addCircle(data: AddCircleDTO): Promise<ResponseModel> {
  try {
    const { hexColor, memberIds } = data;
    if (!data.name || !hexColor) return fail("Invalid input data");
    const name = String(data.name).trim();
    const createdBy = data.createdBy ?? "";

    // ⚠️ CAVEAT §6.1: the source duplicate-name guard checks `res.success`
    // (a non-existent property) so it NEVER blocks create/update. Preserved:
    // duplicate names are allowed on purpose.

    // Members resolved from `users` — full user docs stored as members.
    const members =
      Array.isArray(memberIds) && memberIds.length
        ? (await findManyUsers({ _id: { $in: memberIds } })).map(sanitizeUser)
        : [];

    const now = Date.now();
    const circle: Circle = {
      _id: crypto.randomUUID(), // uuid v4 (NOT a Mongo ObjectId)
      name,
      hexColor,
      members,
      createdBy,
      userId: createdBy,
      description: "",
      createdOn: now,
      modifiedOn: now,
      isDeleted: false,
      modifiedBy: "",
    };

    const inserted = await insertCircle(circle);
    if (!inserted?._id) return fail("Failed to create circle");

    // Fire-and-forget side effect — only when the created circle has an _id.
    void userServicePost("/circles", {
      circleId: inserted._id,
      members: memberIds ?? [],
      userId: createdBy,
    });

    // Publish social.circle.created AFTER the Mongo insert commits
    // (best-effort — never throws, never blocks).
    void publishSocialCircleCreated(String(inserted._id), String(name));

    return ok(inserted, "Circle created successfully");
  } catch {
    return genericError();
  }
}

/* ------------------------------------------------------------------ */
/* PUT /circles/:id — editCircle                                       */
/* ------------------------------------------------------------------ */

/** Business logic for `PUT /circles/:id` (TCP `editCircle`). */
export async function editCircle(data: EditCircleDTO): Promise<ResponseModel> {
  try {
    const { circleId, userId, hexColor } = data;
    if (!data.name || !hexColor) return fail("Invalid input data");
    const name = String(data.name).trim();

    // Ownership/auth check (same rules as getCircleById).
    const circle = await findOneCircle({ _id: circleId });
    if (!circle || circle.isDeleted === true) return fail("Circle not found");
    if (circle.userId !== userId) return fail("You are not authorized");

    // ⚠️ CAVEAT §6.1: duplicate-name validation never blocks (see addCircle).

    await updateCircle({ _id: circleId }, { $set: { name, hexColor } });

    const updated = await findOneCircle({ _id: circleId });
    if (!updated) return fail("Failed to update circle", {});
    return ok(updated, "Circle updated successfully");
  } catch {
    // §4.5 failure shape for this handler uses `data: {}`.
    return fail("Failed to update circle", {});
  }
}

/* ------------------------------------------------------------------ */
/* DELETE /circles/:id — deleteCircleById                              */
/* ------------------------------------------------------------------ */

/** Business logic for `DELETE /circles/:id` (TCP `deleteCircleById`). */
export async function deleteCircleById(
  circleId: string,
  userId: string
): Promise<ResponseModel> {
  try {
    const circle = await findOneCircle({ _id: circleId });
    if (!circle || circle.isDeleted === true) return fail("Circle not found");
    if (circle.userId !== userId) return fail("You are not authorized");

    // Soft delete.
    await updateCircle({ _id: circleId }, { $set: { isDeleted: true } });

    // Side effect (awaited; result only logged, never changes the response).
    await userServiceDelete(`/circles/${circleId}`);

    // Publish social.circle.deleted AFTER the Mongo soft delete commits
    // (best-effort — never throws, never blocks).
    void publishSocialCircleDeleted(String(circleId));

    return ok(null, "Circle deleted successfully");
  } catch {
    return fail("Failed to delete circle");
  }
}

/* ------------------------------------------------------------------ */
/* POST /circles/:id/addmember — addCircleMember                       */
/* ------------------------------------------------------------------ */

/** Business logic for `POST /circles/:id/addmember` (TCP `addCircleMember`). */
export async function addCircleMember(
  data: AddRemoveCircleMemberDTO
): Promise<ResponseModel> {
  try {
    const { circleId, userId, memberIds } = data;

    const circle = await findOneCircle({ _id: circleId });
    if (!circle || circle.isDeleted === true) return fail("Circle not found");
    if (circle.userId !== userId) return fail("You are not authorized");

    const existing = new Set((circle.members ?? []).map((m: any) => String(m._id)));
    const users =
      Array.isArray(memberIds) && memberIds.length
        ? await findManyUsers({ _id: { $in: memberIds } })
        : [];
    const toAdd = users
      .filter((u: any) => !existing.has(String(u._id)))
      .map(sanitizeUser);
    const members = [...(circle.members ?? []), ...toAdd];

    await updateCircle({ _id: circleId }, { $set: { members } });
    const updated = await findOneCircle({ _id: circleId });

    // Publish social.circle.member.added per NEWLY added member AFTER the Mongo
    // update commits (best-effort — never throws, never blocks).
    for (const member of toAdd) {
      void publishSocialCircleMemberAdded(String(circleId), String(member._id));
    }

    // Fire-and-forget side effect — one call per requested member id.
    for (const id of memberIds ?? []) {
      void userServicePost(`/circles/${circleId}/members`, { userId: id, ownerId: userId });
    }

    return ok(updated ?? { ...circle, members }, "Members Added To Circle");
  } catch {
    return genericError();
  }
}

/* ------------------------------------------------------------------ */
/* PUT /circles/:id/removemember — removeCircleMember                  */
/* ------------------------------------------------------------------ */

/** Business logic for `PUT /circles/:id/removemember` (TCP `removeCircleMember`). */
export async function removeCircleMember(
  data: AddRemoveCircleMemberDTO
): Promise<ResponseModel> {
  try {
    const { circleId, userId, memberIds } = data;

    const circle = await findOneCircle({ _id: circleId });
    if (!circle || circle.isDeleted === true) return fail("Circle not found");
    if (circle.userId !== userId) return fail("You are not authorized");

    const removeIds = new Set((memberIds ?? []).map((id) => String(id)));
    const removed = (circle.members ?? []).filter((m: any) =>
      removeIds.has(String(m._id))
    );
    const members = (circle.members ?? []).filter(
      (m: any) => !removeIds.has(String(m._id))
    );

    await updateCircle({ _id: circleId }, { $set: { members } });
    const updated = await findOneCircle({ _id: circleId });

    // Publish social.circle.member.removed per removed member AFTER the Mongo
    // update commits (best-effort — never throws, never blocks).
    for (const member of removed) {
      void publishSocialCircleMemberRemoved(String(circleId), String(member._id));
    }

    // Fire-and-forget side effect — one call per requested member id.
    for (const id of memberIds ?? []) {
      void userServiceDelete(`/circles/${circleId}/members`, {
        userId: id,
        ownerId: userId,
      });
    }

    return ok(updated ?? { ...circle, members }, "Members Removed From Circle");
  } catch {
    return genericError();
  }
}

/* ------------------------------------------------------------------ */
/* GET /circles/validate/:name — validateCircleName                    */
/* ------------------------------------------------------------------ */

/** Business logic for `GET /circles/validate/:name` (TCP `validateCircleName`). */
export async function validateCircleName(
  userId: string,
  name: string
): Promise<ResponseModel> {
  try {
    if (!name || !userId) return fail("Invalid input data");

    const trimmed = String(name).trim();
    const existing = await findOneCircle({
      name: { $regex: trimmed, $options: "i" },
      userId,
      isDeleted: false,
    });

    if (existing) return fail("Circle name already exists");
    return ok(null, "Circle name is available");
  } catch {
    return genericError();
  }
}
