import type { Collection, Document } from "mongodb";

import { getDb } from "./mongo";

/**
 * Physical collection holding the **UserView** projection (browse / find-users).
 *
 * ⚠️ The legacy name is **`userviews`** — Mongoose pluralizes the `UserView`
 * model to that name (the old User-service had no explicit `collection` option),
 * and the sibling Bun service documents it the same way:
 * `MONGO_USER_VIEW_COLLECTION` default `userviews` — "same physical name as User
 * service Mongoose UserView model".
 *
 * This file previously read a collection called `user_view`, which does not
 * exist anywhere in the ecosystem → every lookup returned an empty list, so
 * `GET /blockedusers` answered with no users after a block. Do NOT rename this
 * back: the change is what makes the listing return data.
 */
const USER_VIEW_COLLECTION = "userviews";

async function userView(): Promise<Collection<Document>> {
  return (await getDb()).collection(USER_VIEW_COLLECTION);
}

export interface UserViewQueryOpts {
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
}

export async function findUserViews(
  filter: Record<string, any>,
  opts: UserViewQueryOpts = {}
): Promise<Document[]> {
  let cursor = (await userView()).find(filter);
  if (opts.sort) cursor = cursor.sort(opts.sort);
  if (opts.skip) cursor = cursor.skip(opts.skip);
  if (opts.limit) cursor = cursor.limit(opts.limit);
  return cursor.toArray();
}

export async function countUserViews(filter: Record<string, any>): Promise<number> {
  return (await userView()).countDocuments(filter);
}

export async function aggregateUserViews(pipeline: Document[]): Promise<Document[]> {
  return (await userView()).aggregate(pipeline).toArray();
}
