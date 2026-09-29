/**
 * Payload for `POST /connectionssummary`.
 *
 * `userIds` accepts EITHER a single id (`"user-1"`) or a list
 * (`["user-1", "user-2"]`) — but AT LEAST ONE non-empty id is required.
 * The list is deduplicated and the requested order is preserved.
 *
 * The viewer (`userId`) is ALWAYS taken from the access token; a `userId`
 * sent in the body is ignored.
 */
export interface ConnectionSummaryDTO {
  /** One id or many ids to summarise the relation for. Required. */
  userIds: string[] | string;
}
