/**
 * Response contract for `POST /connectionssummary` (batch relationship summary).
 *
 * Everything is derived from the SAME single source of truth the rest of this
 * service uses: the `connections` collection (plus `blocked` for the block
 * flags and `users` for the display-name enrichment).
 *
 * Identity rule (⚠️ important):
 *   - `following` / `friendrequest` / `followrequest` docs:
 *     `userId` = the actor (follower / sender), `connectionId` = the target.
 *   - `friends` docs exist in BOTH directions (`requestStatus: "accept"`).
 *
 * Flag semantics are all relative to the AUTHENTICATED user ("me"):
 *   isFollowing   → "I follow them"   (userId=me, connectionId=them)
 *   isFollowedBy  → "they follow me"  (userId=them, connectionId=me)
 *   isRequestSent → pending friendrequest I sent
 *   isRequestReceived → pending friendrequest they sent
 *   isBlocked     → I blocked them, isBlockedBy → they blocked me
 * Only `requestStatus: "pending"` request rows are surfaced (accept/reject rows
 * carry no live relation).
 */

/** Single derived state for quick client branching (first match wins). */
export type ConnectionRelation =
  | "self"
  | "blocked"
  | "blocked_by"
  | "friends"
  | "request_received"
  | "request_sent"
  | "follow_request_received"
  | "follow_request_sent"
  | "mutual_follow"
  | "following"
  | "follower"
  | "none";

/** Per-requested-user summary (one entry per id in the request, always present). */
export interface ConnectionSummaryEntry {
  /** The requested user id (echoed exactly as it was sent). */
  userId: string;
  /** True when the requested id is the authenticated user. */
  isSelf: boolean;

  /** Display enrichment from the `users` collection (absent when not found). */
  userName?: string;
  fullName?: string;
  profilePicture?: string;

  /** Relation flags, all relative to the authenticated user. */
  isFriend: boolean;
  isFollowing: boolean;
  isFollowedBy: boolean;
  isRequestSent: boolean;
  isRequestReceived: boolean;
  isFollowRequestSent: boolean;
  isFollowRequestReceived: boolean;
  isBlocked: boolean;
  isBlockedBy: boolean;

  /** Derived single-value state (see `ConnectionRelation`). */
  relation: ConnectionRelation;

  /** Raw pending request docs — `_id` is needed to accept/reject/cancel. */
  requestSentData: Record<string, any> | null;
  requestReceiveData: Record<string, any> | null;
  followRequestSentData: Record<string, any> | null;
  followRequestReceiveData: Record<string, any> | null;
}

/** `data` payload of the response envelope. */
export interface ConnectionSummaryData {
  /** The authenticated user the flags are relative to. */
  userId: string;
  /** Number of summaries returned (= number of ids after de-duplication). */
  totalCount: number;
  connections: ConnectionSummaryEntry[];
}
