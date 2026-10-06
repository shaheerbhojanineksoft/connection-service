/**
 * Payload for `POST /addChildrenConnection` (child → parent request).
 *
 * `userId` is NOT sent by the client — it is always taken from the access token
 * (`X-Userinfo` / verified JWT), so a body `userId` is ignored/overwritten.
 *
 * `connectionId` is the PARENT's user id.
 */
export interface AddChildrenConnectionDTO {
  userId: string;
  connectionId: string;
}
