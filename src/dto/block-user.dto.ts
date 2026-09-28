/**
 * Payload for the Block User functionality (POST /block, POST /unblock).
 *
 * `blockedId` is the ONLY required client field: the Mongo `_id` of the user
 * to block / unblock. The blocker id (`userId`) is ALWAYS taken from the access
 * token (X-Userinfo `sub`); a `userId` sent in the body is ignored.
 */
export interface BlockUserDTO {
  /** Mongo `_id` of the user to block / unblock. Required. */
  blockedId: string;
  /** Optional – ignored by the server (derived from the JWT). */
  userId?: string;
}
