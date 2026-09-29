/**
 * Payload for cancelRequest (source: `CancelRequestDTO`).
 *
 * `userId` is NOT sent by the client — it is always taken from the access token
 * (`RequestContext.currentUserId()`), so a body `userId` is ignored/overwritten.
 *
 * NOTE: the source route has no `ValidationPipe`, so nothing here is validated:
 * an unknown `requestType` simply finds no document → "No Request Found."
 */
export interface CancelRequestDTO {
  /**
   * The other user's id (the request target) — the client MUST send it; typed
   * optional because the source route has no `ValidationPipe`, so a missing
   * value is possible at runtime and simply matches no document.
   */
  connectionId?: string;
  /** `"friendrequest"` | `"followrequest"` (no validation on purpose). */
  requestType?: string;
  /** Optional — ignored, derived from the token. */
  userId?: string;
}

/** `data` returned on success — the `_id` found BEFORE the delete. */
export interface CancelledRequestData {
  _id: string;
}
