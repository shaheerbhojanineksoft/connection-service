import type { Collection, Document } from "mongodb";

import { getDb } from "./mongo";

async function users(): Promise<Collection<Document>> {
  return (await getDb()).collection("users");
}

export async function findOneUser(filter: Record<string, any>): Promise<Document | null> {
  return (await users()).findOne(filter);
}

export async function findManyUsers(filter: Record<string, any>): Promise<Document[]> {
  return (await users()).find(filter).toArray();
}

export interface UserQueryOpts {
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
  /** Use ONLY to EXCLUDE private fields (e.g. `{ password: 0 }`) when returning rows. */
  projection?: Record<string, 0 | 1>;
}

/**
 * Sorted / paginated `users` lookup. Used as the fallback profile source of the
 * blocked-users listing when the `userviews` projection has no rows for the
 * requested ids (see `blockedUsersListing`).
 */
export async function findUsers(
  filter: Record<string, any>,
  opts: UserQueryOpts = {}
): Promise<Document[]> {
  let cursor = (await users()).find(filter, { projection: opts.projection });
  if (opts.sort) cursor = cursor.sort(opts.sort);
  if (opts.skip) cursor = cursor.skip(opts.skip);
  if (opts.limit) cursor = cursor.limit(opts.limit);
  return cursor.toArray();
}

export async function countUsers(filter: Record<string, any>): Promise<number> {
  return (await users()).countDocuments(filter);
}

export async function aggregateUsers(pipeline: Document[]): Promise<Document[]> {
  return (await users()).aggregate(pipeline).toArray();
}

export async function updateUser(
  filter: Record<string, any>,
  update: Document
): Promise<void> {
  await (await users()).updateOne(filter, update);
}
