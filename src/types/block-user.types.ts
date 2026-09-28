/**
 * Response contract for the Block User functionality.
 * Mirrors `webapi-blueorbit` / `Socialmedia-Microservice` exactly so the
 * integration client sees the documented payload and response unchanged.
 */

/** Raw `blocked` document returned in `data` on success. */
export interface BlockedUserDocument {
  /** Document id — epoch-millis timestamp string generated at write time. */
  _id: string;
  /** Blocker (owner) id. */
  userId: string;
  /** Blocked user id. */
  blockedId: string;
  /** Denormalized gender of the blocked user. */
  blockedGender: string;
  /** Denormalized username of the blocked user. */
  blockedUserName: string;
  /** Denormalized full name of the blocked user. */
  blockedFullName: string;
  /** Denormalized profile picture of the blocked user. */
  blockedProfilePicture: string;
  /** Always `true` for this operation. */
  isBlocked: boolean;
  /** Empty for this operation. */
  modifiedBy: string;
  /** Epoch millis timestamp of the write. */
  modifiedOn: number;
}

/** Standard service envelope (`ResponseModel`). */
export interface ResponseModel<T = BlockedUserDocument> {
  isSuccess: boolean;
  data?: T;
  message: string;
}
