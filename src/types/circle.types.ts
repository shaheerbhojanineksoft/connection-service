/**
 * Response contract for the Circles feature (matches the integration contract §7).
 * Kept intentionally loose (`[key: string]: any`) because the raw Mongo documents
 * are returned as-is (the source does not reshape circle docs).
 */

/** A member entry — full user document at write time / profile user when enriched. */
export interface CircleMember {
  _id: string;
  [key: string]: any;
}

/** `circles` collection document. */
export interface Circle {
  _id: string;
  /**
   * Legacy identity field — the production `circles` collection still has the
   * OLD mongoose UNIQUE index `circleId_1`, so every insert must carry a unique
   * value here (null is allowed only ONCE per collection → otherwise E11000).
   * We write the same uuid as `_id`, keeping both ids interchangeable.
   */
  circleId: string;
  name: string;
  hexColor: string;
  members: CircleMember[];
  createdBy: string;
  userId: string;
  description: string;
  createdOn: number;
  modifiedOn: number;
  isDeleted: boolean;
  modifiedBy?: string;
  [key: string]: any;
}

/** One entry of `GET /circles/connections`. */
export interface ConnectionCircleEntry {
  user: { _id: string; fullName: string; profilePicture: string } | undefined;
  circles: Array<{ _id: string; name: string; hexColor: string; createdOn: number }>;
}

/** Standard service envelope — field order: isSuccess, data, message. */
export interface ResponseModel<T = unknown> {
  isSuccess: boolean;
  data?: T;
  message: string;
}
