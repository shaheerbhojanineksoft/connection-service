import type { Collection, Document } from "mongodb";

import { getDb } from "./mongo";

async function circles(): Promise<Collection<Document>> {
  return (await getDb()).collection("circles");
}

export async function findCircles(filter: Record<string, any>): Promise<Document[]> {
  return (await circles()).find(filter).toArray();
}
