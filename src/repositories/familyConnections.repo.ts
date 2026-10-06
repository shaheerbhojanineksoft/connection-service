import { ObjectId } from "mongodb";
import type { Collection, Document } from "mongodb";

import { getDb } from "./mongo";

/**
 * The parent/child (children) requests live in their OWN collection —
 * `familyConnection` — so this flow can never write into (or be confused with)
 * the friend / follow graph in `connections`.
 *
 * ONE document per child → parent request:
 *   { userId: <child _id>, connectionId: <parent _id OR parent email>,
 *     relationType: "children", requestType: "children", requestStatus: ... }
 *
 * `connectionId` is a parent EMAIL only while that parent has no account yet
 * (they were invited by email); the signup flow repoints it to the real `_id`.
 */
export const FAMILY_CONNECTION_COLLECTION = "familyConnection";

async function familyConnections(): Promise<Collection<Document>> {
  return (await getDb()).collection(FAMILY_CONNECTION_COLLECTION);
}

export async function findFamilyConnections(
  filter: Record<string, any>,
  opts: { sort?: Record<string, 1 | -1>; projection?: Record<string, 1 | 0> } = {}
): Promise<Document[]> {
  let cursor = (await familyConnections()).find(filter, { projection: opts.projection });
  if (opts.sort) cursor = cursor.sort(opts.sort);
  return cursor.toArray();
}

export async function findOneFamilyConnection(
  filter: Record<string, any>
): Promise<Document | null> {
  return (await familyConnections()).findOne(filter);
}

/** Same id FORMS + reasoning as `connectionIdLookupForms` (shared lookup shape). */
export function familyConnectionIdLookupForms(id: string): string[] {
  const forms: string[] = [];
  if (typeof id === "string" && id.length === 24 && ObjectId.isValid(id)) {
    forms.push("objectId");
  }
  forms.push("string");
  if (typeof id === "string" && /^\d+$/.test(id)) forms.push("number");
  return forms;
}

/**
 * Look up a `familyConnection` document by the id a CLIENT sent (route param).
 * Mongo does NOT cast a 24-hex string to ObjectId for us, and legacy docs may
 * carry numeric ids — the same forms as `findOneConnectionById` are tried.
 */
export async function findOneFamilyConnectionById(id: string): Promise<Document | null> {
  const collection = await familyConnections();
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

export async function insertFamilyConnection(
  doc: Record<string, any>
): Promise<Record<string, any>> {
  const result = await (await familyConnections()).insertOne(doc);
  return { _id: result.insertedId, ...doc };
}

export async function updateFamilyConnection(
  filter: Record<string, any>,
  update: Document
): Promise<void> {
  await (await familyConnections()).updateOne(filter, update);
}
