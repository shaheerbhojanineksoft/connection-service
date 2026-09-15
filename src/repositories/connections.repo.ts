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
