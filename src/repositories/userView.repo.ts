import type { Collection, Document } from "mongodb";

import { getDb } from "./mongo";

async function userView(): Promise<Collection<Document>> {
  return (await getDb()).collection("user_view");
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
