import { ObjectId } from "mongodb";
import type { Collection, Document } from "mongodb";

import { getDb } from "./mongo";

/**
 * The `connections` collection is used with TWO schemas in the source:
 *   - requestType schema:  { userId, connectionId, requestType, requestStatus }
 *   - boolean schema:      { userId, connectionId, friend, follower, requestSent }
 * Both read the same collection, so one generic find helper covers both.
 */
async function connections(): Promise<Collection<Document>> {
  return (await getDb()).collection("connections");
}

export async function findConnections(
  filter: Record<string, any>,
  projection?: Record<string, 1 | 0>
): Promise<Document[]> {
  return (await connections()).find(filter, { projection }).toArray();
}

/** Single-document lookup (used by cancelrequest to read the pending request). */
export async function findOneConnection(
  filter: Record<string, any>
): Promise<Document | null> {
  return (await connections()).findOne(filter);
}

/**
 * The id FORMS `findOneConnectionById` tries, in order (used for diagnostics).
 * `ObjectId.isValid` also accepts any 12-char string, hence the length check.
 */
export function connectionIdLookupForms(id: string): string[] {
  const forms: string[] = [];
  if (typeof id === "string" && id.length === 24 && ObjectId.isValid(id)) {
    forms.push("objectId");
  }
  forms.push("string");
  if (typeof id === "string" && /^\d+$/.test(id)) forms.push("number");
  return forms;
}

/**
 * Look up a `connections` document by the id a CLIENT sent (route param / body).
 *
 * ⚠️ The source (mongoose) CASTS a 24-hex `_id` string to ObjectId automatically;
 * the raw driver does NOT. A client replaying the id it read from the API
 * therefore never matched a legacy ObjectId document — the exact symptom seen in
 * deployment (accept → "No Request Found", reject → "Something Went wrong").
 * Legacy docs may also carry numeric (epoch-millis) ids, so those are tried too.
 *
 * The REAL `_id` is returned inside the document — callers must reuse it for the
 * follow-up writes (an update filtered by the original string would no-op).
 */
export async function findOneConnectionById(id: string): Promise<Document | null> {
  const collection = await connections();
  const candidates: unknown[] = [];
  if (typeof id === "string" && id.length === 24 && ObjectId.isValid(id)) {
    candidates.push(new ObjectId(id));
  }
  candidates.push(id);
  if (typeof id === "string" && /^\d+$/.test(id)) candidates.push(Number(id));

  for (const candidate of candidates) {
    const doc = await collection.findOne({ _id: candidate as any });
    if (doc) return doc;
  }
  return null;
}

export interface ConnectionQueryOpts {
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
  projection?: Record<string, 1 | 0>;
}

/** Paginated/sorted find (used by the Circles `/connections` listing). */
export async function findConnectionsPaged(
  filter: Record<string, any>,
  opts: ConnectionQueryOpts = {}
): Promise<Document[]> {
  let cursor = (await connections()).find(filter, { projection: opts.projection });
  if (opts.sort) cursor = cursor.sort(opts.sort);
  if (opts.skip) cursor = cursor.skip(opts.skip);
  if (opts.limit) cursor = cursor.limit(opts.limit);
  return cursor.toArray();
}

/**
 * Paginated list of DISTINCT connected users (used by the Circles
 * `/connections` listing).
 *
 * A single relationship can be stored as BOTH a `friends` and a `following`
 * document for the same directed pair (the accept flow writes both — see
 * `acceptFriendRequestFlow`). Listing raw documents therefore returned the same
 * person once per row, and paginating by documents could even split one person
 * across two pages. Grouping by the other-user id collapses each person to a
 * single row — keeping the newest `createdOn` so the newest-first sort and the
 * `page`/`count` window both operate on distinct people.
 */
export async function findDistinctConnectionUsersPaged(
  filter: Record<string, any>,
  opts: ConnectionQueryOpts = {}
): Promise<Document[]> {
  const pipeline: Document[] = [
    { $match: filter },
    { $group: { _id: "$userId", createdOn: { $max: "$createdOn" } } },
  ];
  if (opts.sort) pipeline.push({ $sort: opts.sort });
  if (opts.skip) pipeline.push({ $skip: opts.skip });
  if (opts.limit) pipeline.push({ $limit: opts.limit });
  return (await connections()).aggregate(pipeline).toArray();
}

export async function countConnections(filter: Record<string, any>): Promise<number> {
  return (await connections()).countDocuments(filter);
}

export async function deleteConnections(filter: Record<string, any>): Promise<void> {
  await (await connections()).deleteMany(filter);
}

export async function insertConnection(doc: Record<string, any>): Promise<Record<string, any>> {
  const result = await (await connections()).insertOne(doc);
  return { _id: result.insertedId, ...doc };
}

export async function aggregateConnections(pipeline: Document[]): Promise<Document[]> {
  return (await connections()).aggregate(pipeline).toArray();
}

export async function updateConnection(
  filter: Record<string, any>,
  update: Document
): Promise<void> {
  await (await connections()).updateOne(filter, update);
}

/** Upsert variant — the accept flows write their new friend/following edges this way. */
export async function upsertConnection(
  filter: Record<string, any>,
  update: Document
): Promise<void> {
  await (await connections()).updateOne(filter, update, { upsert: true });
}
