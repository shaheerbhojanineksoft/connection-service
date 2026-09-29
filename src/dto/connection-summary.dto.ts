/**
 * Payload for `POST /connectionssummary`.
 *
 * `userIds` is ALWAYS an array of strings — one id (`["user-1"]`) or many
 * (`["user-1", "user-2"]`), but AT LEAST ONE non-empty id is required.
 * List is deduplicated and the requested order is preserved.
 *
 * The viewer (`userId`) is ALWAYS taken from the access token; a `userId`
 * sent in the body is ignored.
 */
export interface ConnectionSummaryDTO {
  /** One or many user ids — always an array of strings. Required. */
  userIds: string[];
}
