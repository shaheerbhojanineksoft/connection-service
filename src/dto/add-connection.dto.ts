/**
 * Payload for addConnection (source: AddConnectionDTO).
 * `userId` is set from the authenticated request (X-Userinfo), not the body.
 */
export interface AddConnectionDTO {
  userId: string;
  connectionId: string;
  requestType: "following" | "friendrequest" | "friends" | "followrequest" | string;
  requestMessage?: string;
  relationType?: string;
  preApprovedPlan?: boolean;
}
