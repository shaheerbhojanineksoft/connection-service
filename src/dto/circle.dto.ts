/**
 * Payloads for the Circles feature (source: webapi-blueorbit `src/circles`).
 *
 * `createdBy` / `circleId` / `userId` are ALWAYS overwritten server-side from
 * the path param + access token, exactly like the source DTOs.
 */

/**
 * Body for `POST /circles` (source: AddCircleDTO).
 *
 * `name` / `hexColor` are typed OPTIONAL on purpose: the source route has NO
 * `ValidationPipe`, so at runtime they can be absent — the service then answers
 * `"Invalid input data"` (HTTP 201). Typing them as required would only force
 * unsafe casts in the controller.
 */
export interface AddCircleDTO {
  name?: string;
  hexColor?: string;
  memberIds?: string[];
  /** Set server-side from the token (body value ignored). */
  createdBy?: string;
}

/** Body for `PUT /circles/:id` (source: EditCircleDTO). Optional for the same reason. */
export interface EditCircleDTO {
  name?: string;
  hexColor?: string;
  /** Overwritten from the path param. */
  circleId?: string;
  /** Overwritten from the token. */
  userId?: string;
}

/**
 * Body for `POST /circles/:id/addmember` and `PUT /circles/:id/removemember`
 * (source: AddRemoveCircleMemberDTO).
 */
export interface AddRemoveCircleMemberDTO {
  memberIds?: string[];
  /** Overwritten from the path param. */
  circleId?: string;
  /** Overwritten from the token. */
  userId?: string;
}

/** Body for `DELETE /circles/:id` (source: DeleteCircleByIdDTO). */
export interface DeleteCircleByIdDTO {
  /** Overwritten from the path param. */
  circleId?: string;
  /** Overwritten from the token. */
  userId?: string;
}
