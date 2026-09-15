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

export async function updateUser(
  filter: Record<string, any>,
  update: Document
): Promise<void> {
  await (await users()).updateOne(filter, update);
}
