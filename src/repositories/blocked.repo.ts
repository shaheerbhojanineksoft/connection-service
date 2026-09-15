import type { Collection, Document } from "mongodb";

import { getDb } from "./mongo";

async function blocked(): Promise<Collection<Document>> {
  return (await getDb()).collection("blocked");
}

/** Blocked entries for a user, newest first (modifiedOn desc). */
export async function findBlocked(filter: Record<string, any>): Promise<Document[]> {
  return (await blocked()).find(filter).sort({ modifiedOn: -1 }).toArray();
}

export async function findOneBlocked(filter: Record<string, any>): Promise<Document | null> {
  return (await blocked()).findOne(filter);
}
