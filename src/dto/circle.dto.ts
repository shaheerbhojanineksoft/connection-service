/**
 * Payloads for the Circles feature (source: webapi-blueorbit `src/circles`).
 *
 * `createdBy` / `circleId` / `userId` are ALWAYS overwritten server-side from
 * the path param + access token, exactly like the source DTOs.
 */

/** Body for `POST /circles` (source: AddCircleDTO). */
export interface AddCircleDTO {
  name: string;
  hexColor: string;
  memberIds?: string[];
  /** Set server-side from the token (body value ignored). */
  createdBy?: string;
}

/** Body for `PUT /circles/:id` (source: EditCircleDTO). */
export interface EditCircleDTO {
  name: string;
  hexColor: string;
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
