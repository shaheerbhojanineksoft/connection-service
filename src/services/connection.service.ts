import {
  aggregateUserViews,
  countUserViews,
  findUserViews,
} from "../repositories/userView.repo";
import type { AddConnectionDTO } from "../dto/add-connection.dto";
import type { GetConnectionsDTO } from "../dto/get-connections.dto";
import type { CancelRequestDTO } from "../dto/cancel-request.dto";
import {
  deleteBlocked,
  findBlocked,
  findOneBlocked,
  insertBlocked,
  updateBlocked,
} from "../repositories/blocked.repo";
import {
  aggregateConnections,
  connectionIdLookupForms,
  countConnections,
  deleteConnections,
  findConnections,
  findOneConnection,
  findOneConnectionById,
  insertConnection,
  updateConnection,
  upsertConnection,
} from "../repositories/connections.repo";
import { findCircles } from "../repositories/circles.repo";
import { constants } from "../config/constants";
import { findPhotos } from "../repositories/photos.repo";
import { deleteTopFriends } from "../repositories/topfriends.repo";
import { findManyUsers, findOneUser, updateUser } from "../repositories/users.repo";
import {
  publishSocialBlocked,
  publishSocialFollowed,
  publishSocialUnblocked,
  publishSocialUnfollowed,
} from "./nats.publisher";
import type { BlockedUserDocument, ResponseModel } from "../types/block-user.types";

/**
 * Failure log — the response envelope must stay unchanged, so the ONLY place the
 * real error is visible is here. Never swallow an error silently.
 *
 * Mongo error codes worth naming: 11000 duplicate key (a UNIQUE index exists),
 * 121 $jsonSchema validation, 13 not authorized, 50/89 network / timeout.
 */
function logFailure(
  operation: string,
  error: unknown,
  context: Record<string, unknown> = {}
): void {
  const e = error as
    | { name?: string; message?: string; code?: string | number; stack?: string }
    | undefined;
  console.error(
    `[connections] ❌ ${operation} failed (name=${e?.name ?? "Error"}, code=${
      e?.code ?? "-"
    }) context=${JSON.stringify(context)}: ${e?.message ?? String(error)}`
  );
  if (e?.stack) console.error(`[connections] ${operation} stack:\n${e.stack}`);
}

/** Diversification count aggregation (spec §3 / §4 helper). */
async function calculateTotalDiversificationCount(query: Record<string, any>) {
  const [result] = await aggregateUserViews([
    { $match: query },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        ETFs: { $sum: { $cond: [{ $gt: ["$diversification.ETFs", 0] }, 1, 0] } },
        futures: { $sum: { $cond: [{ $gt: ["$diversification.futures", 0] }, 1, 0] } },
        indices: { $sum: { $cond: [{ $gt: ["$diversification.indices", 0] }, 1, 0] } },
        options: { $sum: { $cond: [{ $gt: ["$diversification.options", 0] }, 1, 0] } },
        stocks: { $sum: { $cond: [{ $gt: ["$diversification.stocks", 0] }, 1, 0] } },
        crypto: { $sum: { $cond: [{ $gt: ["$diversification.crypto", 0] }, 1, 0] } },
      },
    },
  ]);
  return result ?? { total: 0, ETFs: 0, futures: 0, indices: 0, options: 0, stocks: 0, crypto: 0 };
}

/** Per-user connection counts (boolean connections schema — spec §3 / §4 helper). */
async function countUsersBatch(userIds: string[]): Promise<Record<string, any>> {
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  if (!uniqueUserIds.length) return {};

  const countsByUser = new Map(
    uniqueUserIds.map((id) => [
      id,
      {
        friends: new Set(),
        followers: new Set(),
        reverseFollowers: new Set(),
        friendRequestSent: new Set(),
      },
    ])
  );

  const rows = await findConnections(
    {
      $or: [
        { userId: { $in: uniqueUserIds }, friend: true },
        { userId: { $in: uniqueUserIds }, follower: true },
        { connectionId: { $in: uniqueUserIds }, follower: true },
        { userId: { $in: uniqueUserIds }, requestSent: true },
      ],
    },
    { userId: 1, connectionId: 1, friend: 1, follower: 1, requestSent: 1, _id: 0 }
  );

  for (const c of rows) {
    const direct = countsByUser.get(c.userId);
    if (direct) {
      if (c.friend) direct.friends.add(c.connectionId);
      if (c.follower) direct.followers.add(c.connectionId);
      if (c.requestSent) direct.friendRequestSent.add(c.connectionId);
    }
    if (c.follower && countsByUser.has(c.connectionId)) {
      countsByUser.get(c.connectionId)!.reverseFollowers.add(c.userId);
    }
  }

  return Object.fromEntries(
    uniqueUserIds.map((id) => {
      const b =
        countsByUser.get(id) ??
        {
          friends: new Set(),
          followers: new Set(),
          reverseFollowers: new Set(),
          friendRequestSent: new Set(),
        };
      const merged = new Set([
        ...b.friends,
        ...b.followers,
        ...b.reverseFollowers,
        ...b.friendRequestSent,
      ]);
      return [
        id,
        {
          allCount: merged.size,
          friendsCount: b.friends.size,
          followersCount: b.followers.size,
          followingCount: b.reverseFollowers.size,
          friendRequestSentCount: b.friendRequestSent.size,
          friendRequestReceivedCount: 0,
        },
      ];
    })
  );
}

/* ------------------------------------------------------------------ */
/* POST /block — block a user (per source spec — Socialmedia blockUser) */
/* ------------------------------------------------------------------ */

/**
 * Business logic for POST /block (per source spec — ALL-IN-ONE, direct Mongo).
 * Payload/response match the integration contract exactly:
 *   request  → { blockedId } (blocker id comes from the token)
 *   response → { isSuccess, data: <blocked document>, message }
 * Service-level failures still resolve (HTTP 201 with isSuccess:false).
 */
export async function blockUser(
  currentUserId: string,
  blockedId: string
): Promise<ResponseModel<BlockedUserDocument>> {
  try {
    // 1. target user — source of the denormalized `blocked*` fields.
    //    Missing target → service-level failure branch.
    const blockedUser = await findOneUser({ _id: blockedId });
    if (!blockedUser) {
      return { isSuccess: false, message: "Something Went Wrong." };
    }

    const now = Date.now();
    const fields = {
      userId: currentUserId,
      blockedId,
      blockedGender: blockedUser.gender ?? "",
      blockedUserName: blockedUser.userName ?? "",
      blockedFullName: blockedUser.fullName ?? "",
      blockedProfilePicture: blockedUser.profilePicture ?? "",
      isBlocked: true,
      modifiedBy: "",
      modifiedOn: now,
    };

    // 2. upsert the blocked document (idempotent — no duplicate edges).
    let data: BlockedUserDocument;
    const existing = await findOneBlocked({ userId: currentUserId, blockedId });
    if (existing) {
      await updateBlocked({ _id: existing._id }, { $set: fields });
      data = { _id: String(existing._id), ...fields };
    } else {
      data = { _id: now.toString(), ...fields };
      await insertBlocked(data);
    }

    // 3. connection cleanup — remove the edge in BOTH directions.
    await deleteConnections({
      $or: [
        { userId: currentUserId, connectionId: blockedId },
        { userId: blockedId, connectionId: currentUserId },
      ],
    });

    // Publish social.blocked AFTER the Mongo block + cleanup commits
    // (best-effort — never throws, never blocks).
    void publishSocialBlocked(String(currentUserId), String(blockedId));

    // 4. recompute friend / follower / following counts for BOTH users.
    await updateFriendAndFollowerCount(currentUserId, blockedId);

    // 5. response — raw stored document, empty message.
    return { isSuccess: true, data, message: "" };
  } catch {
    return { isSuccess: false, message: "Something Went Wrong." };
  }
}

/* ------------------------------------------------------------------ */
/* POST /unblock — remove a block (per source spec)                    */
/* ------------------------------------------------------------------ */

/**
 * Business logic for POST /unblock (per source spec).
 * Deletes the block edge owned by the current user and recomputes cached
 * counts for both ids. Response: `{ isSuccess: true, message: "User unblocked." }`.
 */
export async function unblockUser(currentUserId: string, blockedId: string) {
  try {
    // 1. remove the block edge (only the direction owned by the current user).
    await deleteBlocked({ userId: currentUserId, blockedId });

    // Publish social.unblocked AFTER the Mongo delete commits (best-effort —
    // never throws, never blocks).
    void publishSocialUnblocked(String(currentUserId), String(blockedId));

    // 2. recompute friend / follower / following counts for BOTH users.
    await updateFriendAndFollowerCount(currentUserId, blockedId);

    // 3. response.
    return { isSuccess: true, message: "User unblocked." };
  } catch {
    return { isSuccess: false, message: "Something Went Wrong." };
  }
}

/**
 * Business logic for GET /blockedusers (per source spec — ALL-IN-ONE, no
 * external services; everything is direct Mongo against this service's
 * collections: `users`, `blocked`, `user_view`, `connections`).
 */
export async function blockedUsersListing(currentUserId: string) {
  // 1. user
  const user = await findOneUser({ _id: currentUserId });
  if (!user) return { isSuccess: false, message: "User not found", data: {} };

  // 2. blocked ids (modifiedOn desc)
  const blocked = await findBlocked({ userId: user._id });
  if (!blocked.length) return { isSuccess: true, message: "No data found", data: {} };
  const blockedIds = blocked.map((b: any) => b.blockedId);

  // 3. find-users (custom)
  const query = { id: { $in: blockedIds, $nin: [] }, isProfileCompleted: true };
  const list = await findUserViews(query, {
    sort: { followers: -1, createdOn: -1 },
    skip: 0,
    limit: 10,
  });
  const totalCount = await countUserViews(query);
  const diversificationCount = await calculateTotalDiversificationCount(query);
  const usersWithId = list.map((u: any) => {
    u._id = u.id;
    return u;
  });
  const apiResp = { list: usersWithId, totalCount, totalTraders: totalCount, diversificationCount };
  const userMap = new Map(usersWithId.map((u: any) => [u.id, u]));

  // 4. counts + 5. statuses
  const userIds = usersWithId.map((u: any) => u.id);
  const counts = await countUsersBatch(userIds);
  const [friends, following, reqSent, reqReceived] = await Promise.all([
    findConnections({ userId: currentUserId, connectionId: { $in: userIds }, requestType: "friends" }),
    findConnections({ userId: currentUserId, connectionId: { $in: userIds }, requestType: "following" }),
    findConnections({
      userId: currentUserId,
      connectionId: { $in: userIds },
      requestType: "friendrequest",
      requestStatus: "pending",
    }),
    findConnections({
      userId: { $in: userIds },
      connectionId: currentUserId,
      requestType: "friendrequest",
      requestStatus: "pending",
    }),
  ]);

  // 6. enrich
  for (const u of usersWithId) {
    const c = (counts as Record<string, any>)[u.id];
    if (u && c) {
      u.followersCount = c.followersCount ?? u.followersCount;
      u.followingCount = c.followingCount ?? u.followingCount;
      u.friendCount = c.friendsCount ?? u.friendCount;
    }
  }
  for (const item of following) {
    const u = userMap.get(item.connectionId);
    if (u) u.isFollowing = true;
  }
  for (const item of reqSent) {
    const u = userMap.get(item.connectionId);
    if (u) u.requestSentData = item;
  }
  for (const item of reqReceived) {
    const u = userMap.get(item.connectionId);
    if (u) u.requestReceiveData = item;
  }
  for (const item of friends) {
    const u = userMap.get(item.connectionId);
    if (u) {
      u.isFriend = true;
      u.requestSentData = null;
      u.requestReceiveData = null;
    }
  }

  // 7. response (⚠️ exact typo "Succesfully")
  return { isSuccess: true, message: "Users Found Succesfully", data: apiResp };
}

/* ------------------------------------------------------------------ */
/* GET /photos/:id — photo list gated by privacy (per source spec)     */
/* ------------------------------------------------------------------ */

// Response helper — field order must be: isSuccess, data, message
function ok(data: unknown, message = "") {
  return { isSuccess: true, data, message };
}
function fail(message: string) {
  return { isSuccess: false, data: null, message };
}

const DUMMY_PRIVACY_STATUSES = ["followers", "public", "friends", "global"];

// fills rightSideMenu with a default photos entry (status: public) when missing
function ensurePhotosInRightSideMenu(profile: any) {
  const photoDefault = { name: "Photos", type: "photos", status: "public" };
  if (!profile.profileConfiguration) {
    profile.profileConfiguration = {
      widgets: [],
      tabs: [],
      rightSideMenu: [photoDefault],
    };
    return;
  }
  if (!profile.profileConfiguration.rightSideMenu) {
    profile.profileConfiguration.rightSideMenu = [photoDefault];
    return;
  }
  const exists = profile.profileConfiguration.rightSideMenu.some(
    (x: any) => x.type === "photos"
  );
  if (!exists) profile.profileConfiguration.rightSideMenu.push(photoDefault);
}

/**
 * Business logic for GET /photos/:id (per source spec — privacy-gated photos).
 * - userId          = profile owner (URL param)
 * - currentUserId   = viewer (from X-Userinfo sub)
 * All logic is direct Mongo (users / blocked / connections / circles / photos).
 */
export async function getUserPhotos(userId: string, currentUserId: string) {
  try {
    // 1. owner profile
    const profile = await findOneUser({ _id: userId });
    if (!profile) {
      // data stays undefined → omitted in JSON
      return { isSuccess: true, message: "User not found." };
    }

    // 2. prerequisites
    const isGlobalViewer = currentUserId ? false : true; // always false in practice
    let isMyProfile = true;
    let isFollowing = false;
    let isFriend = false;

    if (!isGlobalViewer) {
      if (String(profile._id) !== String(currentUserId)) {
        isMyProfile = false;

        // owner blocked the viewer?
        const profileBlockData = await findOneBlocked({
          blockedId: currentUserId,
          userId: profile._id,
        });
        if (profileBlockData) {
          return fail("User is blocked");
        }

        // relation check (STRING requestType schema)
        const connections = await findConnections({
          $or: [
            { $and: [{ userId: currentUserId }, { connectionId: profile._id }] },
            { $and: [{ userId: profile._id }, { connectionId: currentUserId }] },
          ],
        });
        const followingConnections = connections.filter(
          (c: any) => c.requestType === "following"
        );
        const friendsConnections = connections.filter(
          (c: any) => c.requestType === "friends"
        );
        isFollowing =
          followingConnections.filter(
            (x: any) => x.userId === currentUserId && x.connectionId === profile._id
          ).length > 0;
        isFriend = friendsConnections.length > 0;
      } else {
        isMyProfile = true;
      }
    } else {
      isMyProfile = false;
    }

    // circles → userCircleIds
    let userCircleIds: string[] = [];
    if (!isGlobalViewer) {
      const circles = await findCircles({
        isDeleted: false,
        "members._id": currentUserId,
        userId: profile._id,
      });
      userCircleIds = circles.map((x: any) => x._id);
    }

    // 3. profile-config fallback (photos default = public)
    ensurePhotosInRightSideMenu(profile);

    // 4. photos privacy config
    const profilePrivacyConfig = profile.profileConfiguration.rightSideMenu.find(
      (x: any) => x.type === "photos"
    );

    // 5. privacy validation
    const status = profilePrivacyConfig.status;
    const passes =
      isMyProfile || status === "global"
        ? true
        : status === "public" && !isGlobalViewer
          ? true
          : status === "followers" && isFollowing
            ? true
            : status === "friends" && isFriend
              ? true
              : status === "circles" &&
                  profilePrivacyConfig.circleIds?.length &&
                  userCircleIds?.length &&
                  profilePrivacyConfig.circleIds.some((id: string) =>
                    userCircleIds.includes(id)
                  )
                ? true
                : false;

    // 6. failed → quirk
    if (!passes) {
      if (!DUMMY_PRIVACY_STATUSES.includes(status)) {
        return fail("privacy restriction");
      }
      return ok(null, "Success"); // ⚠️ isSuccess:true, data:null
    }

    // 7. photos query (type regex image, no sort/limit)
    const photos = await findPhotos({
      $and: [{ userId: { $eq: userId } }, { type: { $regex: "image" } }],
    });

    // 8. empty message ""
    return ok(photos, "");
  } catch {
    return { isSuccess: false, message: "Something Went Wrong." };
  }
}

/* ------------------------------------------------------------------ */
/* GET /connectionscount — friends + following counts (per source spec) */
/* ------------------------------------------------------------------ */

/**
 * Business logic for GET /connectionscount (per source spec).
 * Returns the logged-in user's friends/following counts, excluding
 * connections to blocked (either direction) or deleted users.
 * countDocuments (NOT distinct) — duplicate docs count multiple times.
 */
export async function userFriendsAndFollowingCount(currentUserId: string) {
  try {
    // 1. blockedIds — three sources, concatenated in this exact order
    const myBlocked = await findBlocked({ userId: { $eq: currentUserId } });
    const otherBlocked = await findBlocked({ blockedId: { $eq: currentUserId } });
    const deletedUsers = await findManyUsers({ $or: [{ isDeleted: { $eq: true } }] });

    const blockedIds = [
      ...myBlocked.map((x: any) => x.blockedId),
      ...otherBlocked.map((x: any) => x.userId),
      ...deletedUsers.map((x: any) => x._id),
    ];

    // 2. followingCount
    const followingCount = await countConnections({
      $and: [
        { userId: { $eq: currentUserId } },
        { connectionId: { $nin: blockedIds } },
        { requestType: { $eq: "following" } },
      ],
    });

    // 3. friendsCount
    const friendsCount = await countConnections({
      $and: [
        { userId: { $eq: currentUserId } },
        { connectionId: { $nin: blockedIds } },
        { requestType: { $eq: "friends" } },
      ],
    });

    // 4. response — friendsCount first, message is EMPTY string
    return {
      isSuccess: true,
      data: { friendsCount, followingCount },
      message: "",
    };
  } catch (error) {
    // replicate source: return the raw error as-is
    return error;
  }
}

/* ------------------------------------------------------------------ */
/* POST /unfollow — remove a following connection (per source spec)     */
/* ------------------------------------------------------------------ */

/**
 * Business logic for POST /unfollow (per source spec).
 * Deletes the `following` connection and recomputes + persists cached counts
 * for both ids.
 * ⚠️ catch message typo preserved: "Somthing Went Wrong."
 */
export async function unfollow(currentUserId: string, connectionId: string) {
  try {
    // 1. Socialmedia delete (STRING requestType schema)
    await deleteConnections({
      $and: [
        { userId: { $eq: currentUserId } },
        { connectionId: { $eq: connectionId } },
        { requestType: { $eq: "following" } },
      ],
    });

    // Publish social.unfollowed AFTER the Mongo delete commits (best-effort —
    // never throws, never blocks).
    void publishSocialUnfollowed(String(currentUserId), String(connectionId));

    // 2. fetch user (result only logged) — omit password
    const user = await findOneUser({ _id: currentUserId });
    if (user?.password) delete user.password;
    console.log("user:", user);

    // 3. recompute + persist counts for BOTH ids
    await updateFriendAndFollowerCount(currentUserId, connectionId);

    // 4. Socialmedia response
    const response = { isSuccess: true, message: "Successfully Unfollowed." };

    // 5. return the Socialmedia response
    return response;
  } catch (error: any) {
    console.error("Error Message :", error.message);
    // ⚠️ TYPO preserved — "Somthing Went Wrong."
    return { isSuccess: false, message: "Somthing Went Wrong." };
  }
}

/* ------------------------------------------------------------------ */
/* POST /cancelrequest — cancel a pending request (per source spec)     */
/* ------------------------------------------------------------------ */

/**
 * Business logic for POST /cancelrequest (per integration contract — the
 * SINGLE-SERVICE implementation).
 *
 * ONLY the core cancellation work is implemented:
 *   1. find ONE `connections` document matching
 *      `{ userId, connectionId, requestType, requestStatus: "pending" }`,
 *   2. `deleteMany` with the very same query,
 *   3. return the found document's `_id`.
 *
 * ⛔ NOT implemented on purpose (agreed scope change):
 *   - notification-service HTTP call,
 *   - Firebase `deleteFollowRequestNotification` / `deleteFriendRequestNotification`,
 *   - user-service `POST /connections/remove`.
 *   - no NATS publish either (nothing in the contract asks for an event).
 *
 * Request  → `{ connectionId, requestType }` (userId from the access token)
 * Response → success `{ isSuccess: true, data: { _id }, message: "Request Cancelled Succefully." }`
 *            not found / error → `{ isSuccess: false, message: ... }` (NO `data` key)
 * ⚠️ Message spelling preserved exactly: "Request Cancelled Succefully."
 */
export async function cancelRequest(
  currentUserId: string,
  request: CancelRequestDTO
): Promise<ResponseModel<{ _id: string }>> {
  try {
    // `requestStatus` is hardcoded — only PENDING requests can be cancelled.
    const query = {
      userId: currentUserId,
      connectionId: request.connectionId,
      requestType: request.requestType,
      requestStatus: "pending",
    };

    // 1. find ONE pending request (its _id is what the client gets back).
    const found = await findOneConnection(query);
    if (!found) {
      // `data` stays undefined → the key is absent in the JSON body.
      return { isSuccess: false, message: "No Request Found." };
    }

    // 2. delete ALL documents matching the same query.
    await deleteConnections(query);

    // 3. response — the _id of the document found BEFORE the delete
    //    (String() keeps the JSON identical whether `_id` is an ObjectId or
    //    a string in the collection).
    return {
      isSuccess: true,
      data: { _id: String(found._id) },
      message: "Request Cancelled Succefully.",
    };
  } catch (error) {
    logFailure("cancelRequest", error, {
      userId: currentUserId,
      connectionId: request?.connectionId,
      requestType: request?.requestType,
    });
    return { isSuccess: false, message: "Something Went Wrong." };
  }
}

/* ------------------------------------------------------------------ */
/* POST /removefriend — remove a friend (per contract, Mongo-only)      */
/* ------------------------------------------------------------------ */

/**
 * Business logic for `POST /removefriend` (source: webapi `removeFriend` +
 * Socialmedia `removeFriend`) — MONGO ONLY, step order preserved exactly:
 *   1. delete the `friends` edge in BOTH directions,
 *   2. recompute friend / following / followers counts for BOTH users
 *      (`updateFriendAndFollowerCount` → contract §5.1: blocked + deleted users
 *      are excluded),
 *   3. delete the CURRENT USER's `topfriends` entry (ONE direction only).
 *
 * ⛔ NOT implemented on purpose (contract §6): user-service
 *    `POST /connections/remove`. There is no notification / Firebase / queue /
 *    KEDA work in this flow.
 *
 * `requestType` in the body is accepted but UNUSED; `userId` comes from the token.
 * ⚠️ Exact message: "Friend Removed Successfully."
 */
export async function removeFriend(
  currentUserId: string,
  req: CancelRequestDTO
): Promise<ResponseModel<any>> {
  try {
    // The source route has no ValidationPipe, so the id can be missing — an empty
    // value simply matches no document (same net effect as the source).
    const connectionId = req?.connectionId ?? "";

    // 1. friend edges — BOTH directions.
    await deleteConnections({
      $or: [
        { userId: currentUserId, connectionId, requestType: "friends" },
        { userId: connectionId, connectionId: currentUserId, requestType: "friends" },
      ],
    });

    // 2. recompute + persist the cached counts for both users.
    await updateFriendAndFollowerCount(currentUserId, connectionId);

    // 3. top-friend entry — only the current user's direction.
    await deleteTopFriends({ userId: currentUserId, friendId: connectionId });

    return { isSuccess: true, message: "Friend Removed Successfully." };
  } catch (error) {
    logFailure("removeFriend", error, {
      connectionId: req?.connectionId,
      userId: currentUserId,
    });
    return { isSuccess: false, message: "Something Went Wrong." };
  }
}

/* ------------------------------------------------------------------ */
/* PUT /:id/status/:status — accept / reject a request (per contract)   */
/* ------------------------------------------------------------------ */

/**
 * Business logic for `PUT /:id/status/:status` (source: webapi
 * `updateConnectionStatus` + Socialmedia `respondFriendRequest`) — MONGO ONLY.
 *
 * Entry point → `requestAcceptFlow` / `requestRejectFlow` (same split/name shape
 * as the source `respondFriendRequest`).
 *
 * ⛔ NOT implemented on purpose (contract §7): notification-service calls,
 *    Firebase notification updates, user-service `POST /connections/add` /
 *    `remove`, notification/connection queue jobs and the KEDA post-sync publish.
 * The body `{ notificationId }` is accepted and IGNORED.
 *
 * ⚠️ Message spelling/casing differs per branch ON PURPOSE (contract §3).
 */
export async function updateConnectionStatus(
  requestId: string,
  status: string,
  currentUserId: string
): Promise<ResponseModel<any>> {
  try {
    if (status === "accept") {
      return await requestAcceptFlow(requestId, currentUserId);
    }
    if (status === "reject") {
      return await requestRejectFlow(requestId, currentUserId);
    }
    // ⚠️ typo preserved: "Invald Request Type" (no trailing period)
    return { isSuccess: false, message: "Invald Request Type" };
  } catch (error) {
    logFailure("updateConnectionStatus", error, { requestId, status, userId: currentUserId });
    return { isSuccess: false, message: "Something Went Wrong." };
  }
}

/** Reject branch (contract §5.2) — update `requestStatus` only. */
async function requestRejectFlow(
  requestId: string,
  currentUserId: string
): Promise<ResponseModel<any>> {
  try {
    const request = await findOneConnectionById(requestId);
    // ⚠️ NO null-check on purpose: a missing document throws right here, exactly
    // like the source, and lands in the catch below ("Something Went wrong").
    request!.requestStatus = "reject";

    await updateRequestDoc(request);

    if ((request as any).requestType === "followrequest") {
      return { isSuccess: true, message: "Follow Request Rejected." };
    }
    return { isSuccess: true, message: "Friend Request Rejected." };
  } catch (error) {
    logFailure("requestRejectFlow", error, { requestId, status: "reject", userId: currentUserId });
    // ⚠️ exact source casing: lowercase "w", no trailing period.
    return { isSuccess: false, message: "Something Went wrong" };
  }
}

/** Accept dispatcher (contract §5.3). */
async function requestAcceptFlow(
  requestId: string,
  currentUserId: string
): Promise<ResponseModel<any>> {
  try {
    const request = await findOneConnectionById(requestId);
    if (!request) {
      // Not an error in itself — but the ONLY way to see which id forms were
      // tried when a client sends an id we cannot match.
      console.warn(
        `[connections] ⚠️ updateConnectionStatus accept: no request for id="${requestId}" ` +
          `(lookup tried: ${connectionIdLookupForms(requestId).join(", ") || "none"}, ` +
          `collection="connections" of ${constants.DATABASE_NAME})`
      );
      return { isSuccess: false, message: "No Request Found" };
    }

    request.requestStatus = "accept";

    if (request.requestType === "friendrequest") {
      return await acceptFriendRequestFlow(request, currentUserId);
    }
    if (request.requestType === "followrequest") {
      return await followRequestAcceptFlow(request, currentUserId);
    }
    return { isSuccess: false, message: "No Request Found" };
  } catch (error) {
    logFailure("requestAcceptFlow", error, { requestId, status: "accept", userId: currentUserId });
    // ⚠️ lowercase "s" + the raw error in `data` (source behaviour).
    return { isSuccess: false, message: "something went wrong", data: error };
  }
}

/**
 * Accept · `friendrequest` (contract §5.4) — edges in BOTH directions + counts.
 *
 * ⚠️ Name note: this is NOT called `friendRequestAcceptFlow` because that name is
 * already taken by the pre-existing addConnection auto-accept helper further down
 * this file — two same-named function declarations would silently override each
 * other (the LAST one wins), which is exactly what happened once.
 */
async function acceptFriendRequestFlow(
  request: any,
  currentUserId: string
): Promise<ResponseModel<any>> {
  const requester = String(request.userId); // A
  const target = String(request.connectionId); // B

  const [requesterUser, targetUser] = [await getUser(requester), await getUser(target)];

  // 1. existing FRIEND edges (either direction) …
  const friendRows = await findConnections({
    requestType: "friends",
    $or: [
      { userId: requester, connectionId: target },
      { userId: target, connectionId: requester },
    ],
  });
  const friendFirst = friendRows.filter((r: any) => r.userId === requester);
  const friendSecond = friendRows.filter((r: any) => r.connectionId === requester);

  // 2./3. … create the missing ones (upsert).
  if (friendFirst.length === 0) {
    await upsertAcceptedConnection(requester, target, "friends", request.relationType, requesterUser, targetUser);
  }
  if (friendSecond.length === 0) {
    await upsertAcceptedConnection(target, requester, "friends", request.relationType, targetUser, requesterUser);
  }

  // 4. existing FOLLOWING edges (either direction) …
  const followingRows = await findConnections({
    requestType: "following",
    $or: [
      { userId: requester, connectionId: target },
      { userId: target, connectionId: requester },
    ],
  });
  const followingFirst = followingRows.filter((r: any) => r.userId === requester);
  const followingSecond = followingRows.filter((r: any) => r.connectionId === requester);

  // 5./6. … create the missing ones (upsert).
  if (followingFirst.length === 0) {
    await upsertAcceptedConnection(requester, target, "following", request.relationType, requesterUser, targetUser);
    // Local NATS contract: EVERY new follow edge is announced (same as /addConnection).
    void publishSocialFollowed(requester, target);
  }
  if (followingSecond.length === 0) {
    await upsertAcceptedConnection(target, requester, "following", request.relationType, targetUser, requesterUser);
    void publishSocialFollowed(target, requester);
  }

  // 7. request doc → accept
  await updateRequestDoc(request);

  // 8. counts (§9 diagram) + response
  await updateFriendAndFollowerCount(requester, target);
  return { isSuccess: true, message: "Friend Request Accepted." };
}

/**
 * Accept · `followrequest` (contract §5.5) — status + counts ONLY, NO edges.
 *
 * ⚠️ PRESERVED SOURCE BEHAVIOUR (contract §5.5 steps 2 & 4): `checkIfFollowingExists`
 * returns an OBJECT (always truthy), so `!following1` / `!following2` are NEVER
 * true and the add-following calls never run. Do NOT "fix" this.
 */
async function followRequestAcceptFlow(
  request: any,
  currentUserId: string
): Promise<ResponseModel<any>> {
  const requester = String(request.userId); // A
  const target = String(request.connectionId); // B

  const following1 = await checkIfFollowingExists(requester, target);
  const following2 = await checkIfFollowingExists(target, requester);
  if (!following1 || !following2) {
    // Unreachable by design — kept so the source guard stays visible.
    console.log(
      "[connections] follow-request accept: addFollowing branch skipped (preserved behaviour)"
    );
  }

  await updateRequestDoc(request);
  await updateFriendAndFollowerCount(requester, target);
  return { isSuccess: true, message: "Follow Request Accepted." };
}

/**
 * `$set` the whole request document (all fields except `_id`) plus
 * `modifiedOn` / `modifiedBy`, exactly like the source (§5.2 step 3).
 */
async function updateRequestDoc(request: any): Promise<void> {
  const { _id, ...fields } = request;
  await updateConnection(
    { _id },
    { $set: { ...fields, modifiedOn: Date.now(), modifiedBy: "" } }
  );
}

/**
 * Upsert one friends/following edge created by an ACCEPTED request (§5.4).
 * `_id` is the current epoch-millis string and the denormalized fields come from
 * the `users` collection — same shape the source wrote.
 */
async function upsertAcceptedConnection(
  ownerId: string,
  otherId: string,
  requestType: "friends" | "following",
  relationType: string | undefined,
  owner: any,
  other: any
): Promise<void> {
  const now = Date.now();
  const doc = {
    createdOn: now,
    modifiedOn: now,
    userId: ownerId,
    userName: owner?.userName,
    userFullName: owner?.fullName,
    userCountry: owner?.country,
    userProfilePicture: owner?.profilePicture,
    userGender: owner?.gender,
    userCoverPhoto: owner?.coverPhoto,
    connectionId: otherId,
    connectionName: other?.fullName,
    connectionCountry: other?.country,
    connectionUsername: other?.userName,
    connectionProfilePicture: other?.profilePicture,
    connectionGender: other?.gender,
    connectionCoverPhoto: other?.coverPhoto,
    relationType,
    requestType,
    // friends docs carry "accept" (same as the source addFriend helper).
    ...(requestType === "friends" ? { requestStatus: "accept" } : {}),
  };

  await upsertConnection({ _id: String(now) }, { $set: doc });
}

async function updateFriendAndFollowerCount(userId: string, connectionId: string) {
  await getUserConnections(userId);
  await getUserConnections(connectionId);
}

async function getUserConnections(id: string) {
  const blockedIds = await getBlockedIds(id);

  const conns = await findConnections({
    $and: [
      { userId: { $eq: id } },
      { requestType: { $in: ["friends", "following"] } },
      { connectionId: { $nin: blockedIds } },
    ],
  });

  const friends = conns.filter((x: any) => x.requestType === "friends");
  const following = conns.filter((x: any) => x.requestType === "following");
  const friendCount = [...new Set(friends.map((x: any) => x.connectionId))].length;
  const followingCount = [...new Set(following.map((x: any) => x.connectionId))].length;

  const followerDocs = await findConnections({
    $and: [
      { connectionId: { $eq: id } },
      { requestType: { $eq: "following" } },
      { userId: { $nin: blockedIds } },
    ],
  });
  const followersCount = [...new Set(followerDocs.map((x: any) => x.userId))].length;

  await updateUser(
    { _id: id },
    {
      $set: {
        friendCount,
        followingCount,
        followersCount,
        // §5.6 step 4 — source also stamps these two fields.
        modifiedOn: Date.now(),
        modifiedBy: "",
      },
    }
  );
}

async function getBlockedIds(userId: string): Promise<string[]> {
  const myBlocked = await findBlocked({ userId: { $eq: userId } });
  const blockers = await findBlocked({ blockedId: { $eq: userId } });
  const deleted = await findManyUsers({ $or: [{ isDeleted: { $eq: true } }] });
  return [
    ...myBlocked.map((x: any) => x.blockedId),
    ...blockers.map((x: any) => x.userId),
    ...deleted.map((x: any) => x._id),
  ];
}

/* ------------------------------------------------------------------ */
/* POST /addConnection — friend/follow/following create (per source     */
/* spec — Socialmedia addConnection handler).                          */
/* ------------------------------------------------------------------ */

async function getUser(userId: string) {
  const user = await findOneUser({ _id: userId });
  if (user?.password) delete user.password;
  return user;
}

async function checkIfFollowingExists(userId: string, connectionId: string) {
  const rows = await findConnections({
    $or: [
      { userId, connectionId, requestType: "following" },
      { userId: connectionId, connectionId: userId, requestType: "following" },
    ],
  });
  return {
    firstUser: rows.filter((r: any) => r.userId === userId),
    secondUser: rows.filter((r: any) => r.connectionId === userId),
    isFollowing: rows.length > 0,
  };
}

function buildConnectionDoc(
  data: AddConnectionDTO,
  user: any,
  connection: any
): Record<string, any> {
  return {
    createdOn: Date.now(),
    modifiedOn: Date.now(),
    userId: data.userId,
    userName: user?.userName,
    userFullName: user?.fullName,
    userCountry: user?.country,
    userProfilePicture: user?.profilePicture,
    userGender: user?.gender,
    userCoverPhoto: user?.coverPhoto,
    connectionId: data.connectionId,
    connectionName: connection?.fullName,
    connectionCountry: connection?.country,
    connectionUsername: connection?.userName,
    connectionProfilePicture: connection?.profilePicture,
    connectionGender: connection?.gender,
    connectionCoverPhoto: connection?.coverPhoto,
    relationType: data.relationType,
    requestType: data.requestType,
    requestStatus: data.requestType === "following" ? undefined : "pending",
  };
}

async function addFriendRequest(data: AddConnectionDTO) {
  const user = await getUser(data.userId);
  const connection = await getUser(data.connectionId);
  const doc = buildConnectionDoc(data, user, connection);
  doc.requestType = "friendrequest";
  doc.requestStatus = "pending";
  return insertConnection(doc);
}

async function addFollowRequest(data: AddConnectionDTO) {
  const user = await getUser(data.userId);
  const connection = await getUser(data.connectionId);
  const doc = buildConnectionDoc(data, user, connection);
  doc.requestType = "followrequest";
  doc.requestStatus = "pending";
  return insertConnection(doc);
}

async function addFriend(data: any) {
  const user = await getUser(data.userId);
  const connection = await getUser(data.connectionId);
  const doc = buildConnectionDoc(data, user, connection);
  doc.requestType = "friends";
  doc.requestStatus = "accept";
  return insertConnection(doc);
}

async function addFollowing(data: AddConnectionDTO) {
  const user = await getUser(data.userId);
  const connection = await getUser(data.connectionId);
  const doc = buildConnectionDoc(data, user, connection);
  doc.requestType = "following";
  const saved = await insertConnection(doc);

  // Publish social.followed AFTER the Mongo insert commits (best-effort —
  // never throws, never blocks). Fires for every new follow edge: direct
  // follow, friend-request auto-follow, and auto-accept (both directions).
  void publishSocialFollowed(String(data.userId), String(data.connectionId));

  return saved;
}

async function updateFollowingCount(user: any, userId: string) {
  const followingCount = await countConnections({ userId, requestType: "following" });
  await updateUser({ _id: userId }, { $set: { followingCount } });
}

async function updateFollowerCount(user: any, userId: string) {
  const followersCount = await countConnections({
    connectionId: userId,
    requestType: "following",
  });
  await updateUser({ _id: userId }, { $set: { followersCount } });
}

// preApprovedPlan auto-accept flow (per source spec §7)
async function friendRequestAcceptFlow(
  newConnection: any,
  opts: { hideNotification: boolean; requestStatus: string }
) {
  // 1. ensure friends records in both directions
  await addFriend({
    userId: newConnection.userId,
    connectionId: newConnection.connectionId,
    requestType: "friends",
    relationType: newConnection.relationType,
  });
  await addFriend({
    userId: newConnection.connectionId,
    connectionId: newConnection.userId,
    requestType: "friends",
    relationType: newConnection.relationType,
  });
  // 2. ensure following records in both directions
  await addFollowing({
    userId: newConnection.userId,
    connectionId: newConnection.connectionId,
    requestType: "following",
    relationType: newConnection.relationType,
  });
  await addFollowing({
    userId: newConnection.connectionId,
    connectionId: newConnection.userId,
    requestType: "following",
    relationType: newConnection.relationType,
  });
  // 3. set the pending friendrequest to accept
  await updateConnection({ _id: newConnection._id }, { $set: { requestStatus: opts.requestStatus } });
  // 4. hideNotification → skip notification/queue block
}

/**
 * Business logic for POST /addConnection (per source spec — Socialmedia
 * addConnection handler). requestType: friendrequest / followrequest / following.
 */
export async function addConnection(data: AddConnectionDTO) {
  try {
    // guard: self-connection
    if (data.userId === data.connectionId) {
      return { isSuccess: false, data: {}, message: "Please add correct connection Id " };
    }

    switch (data.requestType) {
      case "friendrequest": {
        const existing = await findConnections({
          $or: [
            {
              $and: [
                { userId: data.userId },
                { connectionId: data.connectionId },
                { requestType: "friendrequest" },
                { requestStatus: "pending" },
              ],
            },
            {
              $and: [
                { userId: data.connectionId },
                { connectionId: data.userId },
                { requestType: "friendrequest" },
                { requestStatus: "pending" },
              ],
            },
          ],
        });
        if (!data.relationType) data.relationType = "Friend";
        if (!existing.length) {
          const newConnection = await addFriendRequest(data);
          const followingCheck = await checkIfFollowingExists(data.userId, data.connectionId);
          if (followingCheck.firstUser.length === 0) {
            const newFollower = await addFollowing(data);
            const user = await getUser(data.userId);
            if (user?.isProfileCompleted == false)
              return { isSuccess: false, data: null, message: "No User Found" };
            const connection = await getUser(data.connectionId);
            if (connection?.isProfileCompleted == false)
              return { isSuccess: false, data: null, message: "No User Found" };
            await updateFollowingCount(user, data.userId);
            await updateFollowerCount(connection, data.connectionId);
          }
          if (data.preApprovedPlan) {
            await friendRequestAcceptFlow(newConnection, {
              hideNotification: true,
              requestStatus: "accept",
            });
            return { isSuccess: true, data: newConnection, message: "Friend Added." };
          } else {
            newConnection.message = "sent you a friend request";
            newConnection.type = "friendrequest";
            return { isSuccess: true, data: newConnection, message: "Friend Request Added." };
          }
        }
        return { isSuccess: true, data: null, message: "Friend Request Already Exists." };
      }

      case "followrequest": {
        const existing = await findConnections({
          $or: [
            {
              $and: [
                { userId: data.userId },
                { connectionId: data.connectionId },
                { requestType: "followrequest" },
                { requestStatus: "pending" },
              ],
            },
            {
              $and: [
                { userId: data.connectionId },
                { connectionId: data.userId },
                { requestType: "followrequest" },
                { requestStatus: "pending" },
              ],
            },
          ],
        });
        if (!existing.length) {
          const newFollowConnection = await addFollowRequest(data);
          newFollowConnection.message = "sent you a follow request";
          newFollowConnection.type = "followrequest";
          return { isSuccess: true, data: newFollowConnection, message: "Follow request added" };
        }
        return { isSuccess: true, data: null, message: "follow Request Already Exists." };
      }

      case "following": {
        const existing = await findConnections({
          $and: [
            { userId: { $eq: data.userId } },
            { connectionId: { $eq: data.connectionId } },
            { requestType: { $eq: "following" } },
          ],
        });
        if (!existing.length) {
          const newFollower = await addFollowing(data);
          const user = await getUser(data.userId);
          if (user?.isProfileCompleted == false)
            return { isSuccess: false, data: null, message: "No User Found" };
          const connection = await getUser(data.connectionId);
          if (connection?.isProfileCompleted == false)
            return { isSuccess: false, data: null, message: "No User Found" };
          await updateFriendAndFollowerCount(data.userId, data.connectionId);
          newFollower.message = "started following you";
          newFollower.type = "following";
          return { isSuccess: true, data: newFollower, message: "Following Added." };
        }
        return { isSuccess: true, data: null, message: "Following Already Exists." };
      }

      default:
        return { isSuccess: false, data: null, message: "Invalid Request Type" };
    }
  } catch (error) {
    return { isSuccess: false, data: error, message: "Something Went Wrong." };
  }
}

/* ------------------------------------------------------------------ */
/* GET /connections — read-only connections list (per source spec)      */
/* ------------------------------------------------------------------ */

/** $match per connectionType (spec §6). */
function getConnectionQuery(data: GetConnectionsDTO): Record<string, any> {
  const { userId, connectionType } = data;
  switch (connectionType) {
    case "all":
      return {
        $or: [
          { userId, requestType: "friends" },
          { connectionId: userId, requestType: "following" },
          { userId, requestType: "following" },
          { userId, requestType: "friendrequest", requestStatus: "pending" },
          { connectionId: userId, requestType: "friendrequest", requestStatus: "pending" },
        ],
      };
    case "friends":
      return { userId: { $eq: userId }, requestType: { $eq: "friends" } };
    case "followers":
      return { connectionId: { $eq: userId }, requestType: { $eq: "following" } };
    case "following":
      return { userId: { $eq: userId }, requestType: { $eq: "following" } };
    case "invited":
      return {
        userId: { $eq: userId },
        requestType: { $eq: "friendrequest" },
        requestStatus: { $eq: "pending" },
      };
    case "requests":
      return {
        connectionId: { $eq: userId },
        requestType: { $eq: "friendrequest" },
        requestStatus: { $eq: "pending" },
      };
    default:
      return { $or: [{ userId, requestType: "friends" }] };
  }
}

/**
 * Business logic for GET /connections (per source spec — Socialmedia
 * getConnections handler). Read-only: 8-stage aggregation + dedup + friend filter.
 */
export async function getConnections(data: GetConnectionsDTO) {
  try {
    // 1-2. aggregation pipeline (spec §7 — 8 stages)
    const tempConnections = await aggregateConnections([
      { $match: getConnectionQuery(data) },
      {
        $lookup: {
          from: "connections",
          localField: "connectionId",
          foreignField: "userId",
          as: "userConnections",
        },
      },
      {
        $lookup: {
          from: "connections",
          localField: "connectionId",
          foreignField: "connectionId",
          as: "connConnections",
        },
      },
      {
        $lookup: {
          from: "posts",
          localField: "userId",
          foreignField: "userId",
          as: "userPostsArr",
        },
      },
      {
        $lookup: {
          from: "posts",
          localField: "connectionId",
          foreignField: "userId",
          as: "connPostsArr",
        },
      },
      {
        $lookup: {
          from: "followstocks",
          let: { userIdlet: "$userId" },
          pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$userId", "$$userIdlet"] }] } } }],
          as: "userStocksArr",
        },
      },
      {
        $lookup: {
          from: "followstocks",
          let: { userIdlet: "$connectionId" },
          pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$userId", "$$userIdlet"] }] } } }],
          as: "connStocksArr",
        },
      },
      {
        $project: {
          userConnections: {
            $filter: {
              input: "$userConnections",
              as: "userConn",
              cond: {
                $or: [
                  { $eq: ["$$userConn.userId", data.authenticatedUserId] },
                  { $eq: ["$$userConn.connectionId", data.authenticatedUserId] },
                ],
              },
            },
          },
          connConnections: {
            $filter: {
              input: "$connConnections",
              as: "userConn",
              cond: {
                $or: [
                  { $eq: ["$$userConn.userId", data.authenticatedUserId] },
                  { $eq: ["$$userConn.connectionId", data.authenticatedUserId] },
                ],
              },
            },
          },
          _id: 1,
          connectionId: 1,
          connectionName: 1,
          isPublic: 1,
          connectionProfilePicture: 1,
          connectionCoverPhoto: 1,
          userCoverPhoto: 1,
          connectionUsername: 1,
          createdOn: 1,
          userCountry: 1,
          connectionCountry: 1,
          modifiedBy: 1,
          modifiedOn: 1,
          requestType: 1,
          relationType: 1,
          requestStatus: 1,
          userFullName: 1,
          userId: 1,
          userGender: 1,
          connectionGender: 1,
          userName: 1,
          userProfilePicture: 1,
          connPosts: { $size: "$connPostsArr" },
          userPosts: { $size: "$userPostsArr" },
          connStocks: { $size: "$connStocksArr" },
          userStocks: { $size: "$userStocksArr" },
        },
      },
    ]);

    // 3. de-duplication — direction-agnostic pair key (A→B == B→A)
    const connections: any[] = [];
    for (const item of tempConnections) {
      const index = connections.findIndex(
        (x) =>
          (item.userId === x.userId && item.connectionId === x.connectionId) ||
          (item.userId === x.connectionId && item.connectionId === x.userId)
      );
      if (index !== -1) {
        const existing = connections[index];
        if (
          existing.requestType !== "friends" &&
          existing.requestType !== "friendrequest" &&
          (item.requestType === "friends" || item.requestType === "friendrequest")
        ) {
          connections[index] = { ...item }; // upgrade to friends/friendrequest
        }
      } else {
        connections.push(item);
      }
    }

    // 4. friend filter (only for following / followers)
    if (data.connectionType !== "friends" && data.connectionType !== "all") {
      const friends = await findConnections({ userId: data.userId, requestType: "friends" });
      if (data.connectionType === "following") {
        return {
          isSuccess: true,
          data: connections.filter((x) => !friends.some((f) => f.connectionId === x.connectionId)),
          message: "",
        };
      } else if (data.connectionType === "followers") {
        return {
          isSuccess: true,
          data: connections.filter((x) => !friends.some((f) => f.connectionId === x.userId)),
          message: "",
        };
      }
    }

    // 5. response — message is EMPTY string
    return { isSuccess: true, data: connections, message: "" };
  } catch {
    return { isSuccess: false, data: null, message: "Something Went Wrong." };
  }
}
