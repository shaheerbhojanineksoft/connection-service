/**
 * Payload for getConnections (source: GetConnectionsDTO).
 * `authenticatedUserId` is set from auth; `userId` defaults to the
 * authenticated user when not provided.
 */
export interface GetConnectionsDTO {
  connectionType:
    | "requests"
    | "invited"
    | "following"
    | "followers"
    | "friends"
    | "all"
    | string;
  userId: string;
  authenticatedUserId: string;
}
