import type { Collection, Document } from "mongodb";

import { getDb } from "./mongo";

/**
 * The `topfriends` collection — the user's pinned/top friends.
 * Written by the (external) top-friend feature; this service only DELETES the
 * current user's entry when that friend is removed.
 */
async function topfriends(): Promise<Collection<Document>> {
  return (await getDb()).collection("topfriends");
}

/** Delete top-friend entries (removeFriend deletes ONE direction only). */
export async function deleteTopFriends(filter: Record<string, any>): Promise<void> {
  await (await topfriends()).deleteMany(filter);
}
