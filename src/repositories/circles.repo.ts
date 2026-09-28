import type { Collection, Document } from "mongodb";

import { getDb } from "./mongo";

async function circles(): Promise<Collection<Document>> {
  return (await getDb()).collection("circles");
}

export interface CircleQueryOpts {
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
}

export async function findCircles(
  filter: Record<string, any>,
  opts: CircleQueryOpts = {}
): Promise<Document[]> {
  let cursor = (await circles()).find(filter);
  if (opts.sort) cursor = cursor.sort(opts.sort);
  if (opts.skip) cursor = cursor.skip(opts.skip);
  if (opts.limit) cursor = cursor.limit(opts.limit);
  return cursor.toArray();
}

export async function findOneCircle(filter: Record<string, any>): Promise<Document | null> {
  return (await circles()).findOne(filter);
}

export async function insertCircle(doc: Record<string, any>): Promise<Record<string, any>> {
  await (await circles()).insertOne(doc);
  return doc;
}

export async function updateCircle(
  filter: Record<string, any>,
  update: Document
): Promise<void> {
  await (await circles()).updateOne(filter, update);
}
