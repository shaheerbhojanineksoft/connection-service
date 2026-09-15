import { Db, MongoClient } from "mongodb";

import { constants } from "../config/constants";

let client: MongoClient | null = null;
let db: Db | null = null;

/** Lazily create the Mongo connection. Returns the target DB. */
export async function getDb(): Promise<Db> {
  if (db) return db;
  client = new MongoClient(constants.DATABASE_URL, {
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  db = client.db(constants.DATABASE_NAME);
  console.log(`[mongo] connected to ${constants.DATABASE_URL}/${constants.DATABASE_NAME}`);
  return db;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
