import type { Collection, Document } from "mongodb";

import { getDb } from "./mongo";

async function photos(): Promise<Collection<Document>> {
  return (await getDb()).collection("photos");
}

export async function findPhotos(filter: Record<string, any>): Promise<Document[]> {
  return (await photos()).find(filter).toArray();
}
