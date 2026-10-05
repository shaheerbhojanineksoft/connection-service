/**
 * NATS JetStream publisher for social graph events and connection-notification jobs.
 *
 * 1) SOCIAL stream (see "NATS Publisher Integration Guide — Follow / Unfollow / Block"):
 *   - `social.followed`   -> publish AFTER the Mongo follow edge insert commits
 *   - `social.unfollowed` -> publish AFTER the Mongo follow edge delete commits
 *   - payload is a UTF-8 JSON object: { followerId, followedId, mts }
 *   - publish via JetStream (persisted); PubAck confirms acceptance
 *   - stream name is FIXED: SOCIAL (bound to `social.>`)
 *
 * 2) CONNECTIONS_NOTIFICATION stream (see "Connections Notifications — Producer Contract"):
 *   - `connections.notification.jobs` -> payload { id } where `id` is the
 *     `connections` document `_id` (a string), NOT a user id
 *   - publish ONLY after the document is written/updated, and only for the
 *     contracted states: following / friendrequest+pending / friendrequest+accept /
 *     friendrequest+reject (`friends` is never published)
 *   - the stream + durable are OWNED BY THE NOTIFICATION WORKER: we publish with
 *     an expected-stream check and NEVER create the stream ourselves
 *
 * Every function here is best-effort and NEVER throws, so a NATS outage can
 * never break follow / unfollow / friend-request flows in this service. Callers
 * use `void publish...()` to avoid adding any latency to the request path.
 * Connection and every publish are logged to the console.
 */
import { connect, StringCodec } from "nats";
import type { JetStreamClient, NatsConnection } from "nats";

import { constants } from "../config/constants";

const sc = StringCodec();

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
let connecting: Promise<void> | null = null;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logError(context: string, err: unknown): void {
  console.error(`[nats-social-publisher] ${context}: ${errMsg(err)}`);
}

/**
 * Ensure the SOCIAL JetStream stream exists (idempotent). The
 * feed-data-sync-service also creates/reconciles it on boot; doing it here too
 * removes the "publish before stream exists = message lost" startup race.
 * If it already exists (bound to `social.>` or the social subjects), we leave
 * it alone. Best-effort — never throws.
 */
async function ensureSocialStream(client: NatsConnection): Promise<void> {
  try {
    const jsm = await client.jetstreamManager();
    try {
      await jsm.streams.info(constants.SOCIAL_STREAM);
      // already exists — feed-data-sync-service reconciles it, nothing to do
    } catch {
      await jsm.streams.add({ name: constants.SOCIAL_STREAM, subjects: ["social.>"] });
      console.log(`[nats-social-publisher] ✅ created ${constants.SOCIAL_STREAM} stream`);
    }
  } catch (err) {
    logError("ensureSocialStream", err);
  }
}

/**
 * Lazily connect (single shared connection, reused across publishes).
 * Never throws — returns null when NATS is unavailable (caller just skips).
 */
async function getJetStream(): Promise<JetStreamClient | null> {
  if (js) return js;

  if (!connecting) {
    connecting = (async () => {
      try {
        // Auth is sent only if BOTH user and password are non-blank.
        const hasAuth = Boolean(constants.NATS_USER && constants.NATS_PASSWORD);
        nc = await connect({
          servers: constants.NATS_URL,
          ...(hasAuth ? { user: constants.NATS_USER, pass: constants.NATS_PASSWORD } : {}),
        });
        await ensureSocialStream(nc);
        js = nc.jetstream();
        console.log(`[nats-social-publisher] ✅ connected to NATS at ${constants.NATS_URL}`);
      } catch (err) {
        logError("connect", err);
        nc = null;
        js = null;
      } finally {
        connecting = null; // allow a retry attempt on the next publish
      }
    })();
  }

  await connecting;
  return js;
}

function encode(data: unknown): Uint8Array {
  return sc.encode(JSON.stringify(data));
}

/**
 * Publish a "followed" event. Best-effort, never throws.
 * Call AFTER the Mongo follow edge for (followerId -> followedId) commits.
 */
export async function publishSocialFollowed(
  followerId: string,
  followedId: string
): Promise<void> {
  try {
    const client = await getJetStream();
    if (!client) return;
    const pa = await client.publish(
      constants.SOCIAL_FOLLOWED_SUBJECT,
      encode({ followerId, followedId, mts: Date.now() })
    );
    console.log(
      `[nats-social-publisher] 📤 ${constants.SOCIAL_FOLLOWED_SUBJECT} ` +
        `{ followerId=${followerId}, followedId=${followedId} } seq=${pa.seq}`
    );
  } catch (err) {
    logError(
      `publish ${constants.SOCIAL_FOLLOWED_SUBJECT} followerId=${followerId} followedId=${followedId}`,
      err
    );
  }
}

/**
 * Publish an "unfollowed" event. Best-effort, never throws.
 * Call AFTER the Mongo follow edge for (followerId -> followedId) commits.
 */
export async function publishSocialUnfollowed(
  followerId: string,
  followedId: string
): Promise<void> {
  try {
    const client = await getJetStream();
    if (!client) return;
    const pa = await client.publish(
      constants.SOCIAL_UNFOLLOWED_SUBJECT,
      encode({ followerId, followedId, mts: Date.now() })
    );
    console.log(
      `[nats-social-publisher] 📤 ${constants.SOCIAL_UNFOLLOWED_SUBJECT} ` +
        `{ followerId=${followerId}, followedId=${followedId} } seq=${pa.seq}`
    );
  } catch (err) {
    logError(
      `publish ${constants.SOCIAL_UNFOLLOWED_SUBJECT} followerId=${followerId} followedId=${followedId}`,
      err
    );
  }
}

/**
 * Publish a "blocked" event. Best-effort, never throws.
 * Call AFTER the Mongo block upsert + connection cleanup commits.
 * Payload matches feed-data-sync-service `BlockEventSchema`: { blockerId, blockedId, mts }.
 */
export async function publishSocialBlocked(
  blockerId: string,
  blockedId: string
): Promise<void> {
  try {
    const client = await getJetStream();
    if (!client) return;
    const pa = await client.publish(
      constants.SOCIAL_BLOCKED_SUBJECT,
      encode({ blockerId, blockedId, mts: Date.now() })
    );
    console.log(
      `[nats-social-publisher] 📤 ${constants.SOCIAL_BLOCKED_SUBJECT} ` +
        `{ blockerId=${blockerId}, blockedId=${blockedId} } seq=${pa.seq}`
    );
  } catch (err) {
    logError(
      `publish ${constants.SOCIAL_BLOCKED_SUBJECT} blockerId=${blockerId} blockedId=${blockedId}`,
      err
    );
  }
}

/**
 * Publish an "unblocked" event. Best-effort, never throws.
 * Call AFTER the Mongo block delete commits.
 * Payload matches feed-data-sync-service `BlockEventSchema`: { blockerId, blockedId, mts }.
 */
export async function publishSocialUnblocked(
  blockerId: string,
  blockedId: string
): Promise<void> {
  try {
    const client = await getJetStream();
    if (!client) return;
    const pa = await client.publish(
      constants.SOCIAL_UNBLOCKED_SUBJECT,
      encode({ blockerId, blockedId, mts: Date.now() })
    );
    console.log(
      `[nats-social-publisher] 📤 ${constants.SOCIAL_UNBLOCKED_SUBJECT} ` +
        `{ blockerId=${blockerId}, blockedId=${blockedId} } seq=${pa.seq}`
    );
  } catch (err) {
    logError(
      `publish ${constants.SOCIAL_UNBLOCKED_SUBJECT} blockerId=${blockerId} blockedId=${blockedId}`,
      err
    );
  }
}

/**
 * Publish a "circle.created" event. Best-effort, never throws.
 * Call AFTER the Mongo circle insert commits.
 * Payload matches feed-data-sync-service `CircleCreatedEventSchema`: { circleId, name, mts }.
 */
export async function publishSocialCircleCreated(
  circleId: string,
  name: string
): Promise<void> {
  try {
    const client = await getJetStream();
    if (!client) return;
    const pa = await client.publish(
      constants.SOCIAL_CIRCLE_CREATED_SUBJECT,
      encode({ circleId, name, mts: Date.now() })
    );
    console.log(
      `[nats-social-publisher] 📤 ${constants.SOCIAL_CIRCLE_CREATED_SUBJECT} ` +
        `{ circleId=${circleId}, name=${name} } seq=${pa.seq}`
    );
  } catch (err) {
    logError(
      `publish ${constants.SOCIAL_CIRCLE_CREATED_SUBJECT} circleId=${circleId}`,
      err
    );
  }
}

/**
 * Publish a "circle.updated" event. Best-effort, never throws.
 * Call AFTER the Mongo circle update commits (name / hexColor edits).
 * Payload matches feed-data-sync-service `CircleUpdatedEventSchema`: { circleId, name, mts }.
 */
export async function publishSocialCircleUpdated(
  circleId: string,
  name: string
): Promise<void> {
  try {
    const client = await getJetStream();
    if (!client) return;
    const pa = await client.publish(
      constants.SOCIAL_CIRCLE_UPDATED_SUBJECT,
      encode({ circleId, name, mts: Date.now() })
    );
    console.log(
      `[nats-social-publisher] 📤 ${constants.SOCIAL_CIRCLE_UPDATED_SUBJECT} ` +
        `{ circleId=${circleId}, name=${name} } seq=${pa.seq}`
    );
  } catch (err) {
    logError(
      `publish ${constants.SOCIAL_CIRCLE_UPDATED_SUBJECT} circleId=${circleId}`,
      err
    );
  }
}

/**
 * Publish a "circle.deleted" event. Best-effort, never throws.
 * Call AFTER the Mongo soft delete commits.
 * Payload matches feed-data-sync-service `CircleDeletedEventSchema`: { circleId, mts }.
 */
export async function publishSocialCircleDeleted(circleId: string): Promise<void> {
  try {
    const client = await getJetStream();
    if (!client) return;
    const pa = await client.publish(
      constants.SOCIAL_CIRCLE_DELETED_SUBJECT,
      encode({ circleId, mts: Date.now() })
    );
    console.log(
      `[nats-social-publisher] 📤 ${constants.SOCIAL_CIRCLE_DELETED_SUBJECT} ` +
        `{ circleId=${circleId} } seq=${pa.seq}`
    );
  } catch (err) {
    logError(
      `publish ${constants.SOCIAL_CIRCLE_DELETED_SUBJECT} circleId=${circleId}`,
      err
    );
  }
}

/**
 * Publish a "circle.member.added" event. Best-effort, never throws.
 * Call AFTER the Mongo members update commits — one event per newly added member.
 * Payload matches feed-data-sync-service `CircleMemberEventSchema`: { circleId, userId, mts }.
 */
export async function publishSocialCircleMemberAdded(
  circleId: string,
  userId: string
): Promise<void> {
  try {
    const client = await getJetStream();
    if (!client) return;
    const pa = await client.publish(
      constants.SOCIAL_CIRCLE_MEMBER_ADDED_SUBJECT,
      encode({ circleId, userId, mts: Date.now() })
    );
    console.log(
      `[nats-social-publisher] 📤 ${constants.SOCIAL_CIRCLE_MEMBER_ADDED_SUBJECT} ` +
        `{ circleId=${circleId}, userId=${userId} } seq=${pa.seq}`
    );
  } catch (err) {
    logError(
      `publish ${constants.SOCIAL_CIRCLE_MEMBER_ADDED_SUBJECT} circleId=${circleId} userId=${userId}`,
      err
    );
  }
}

/**
 * Publish a "circle.member.removed" event. Best-effort, never throws.
 * Call AFTER the Mongo members update commits — one event per removed member.
 * Payload matches feed-data-sync-service `CircleMemberEventSchema`: { circleId, userId, mts }.
 */
export async function publishSocialCircleMemberRemoved(
  circleId: string,
  userId: string
): Promise<void> {
  try {
    const client = await getJetStream();
    if (!client) return;
    const pa = await client.publish(
      constants.SOCIAL_CIRCLE_MEMBER_REMOVED_SUBJECT,
      encode({ circleId, userId, mts: Date.now() })
    );
    console.log(
      `[nats-social-publisher] 📤 ${constants.SOCIAL_CIRCLE_MEMBER_REMOVED_SUBJECT} ` +
        `{ circleId=${circleId}, userId=${userId} } seq=${pa.seq}`
    );
  } catch (err) {
    logError(
      `publish ${constants.SOCIAL_CIRCLE_MEMBER_REMOVED_SUBJECT} circleId=${circleId} userId=${userId}`,
      err
    );
  }
}

/**
 * Publish a connection-notification job ("Connections Notifications — Producer
 * Contract"). Best-effort, never throws.
 *
 * Call ONLY after the `connections` document is written/updated (committed) —
 * the worker reads the document itself from Mongo using this id.
 *
 * ⚠️ The `CONNECTIONS_NOTIFICATION` stream + durable belong to the notification
 * worker, so we publish with `expect.streamName` instead of creating the stream:
 * if the worker has not provisioned it yet, the publish fails (distinct warning
 * below) and the event is dropped — re-publishing the same `_id` on the next
 * connection event is safe (the worker dedupes on `eventId = connection:<_id>`).
 *
 * Never throws. Returns `true` ONLY when JetStream ACKed the publish, so callers
 * can log the outcome (success AND failure) of every dispatch position.
 */
export async function publishConnectionNotification(
  connectionDocId: string
): Promise<boolean> {
  const id = String(connectionDocId);
  try {
    const client = await getJetStream();
    // NATS unreachable / not configured — nothing was published (best-effort).
    if (!client) return false;
    const pa = await client.publish(
      constants.CONNECTIONS_NATS_SUBJECT,
      encode({ id }),
      { expect: { streamName: constants.CONNECTIONS_NATS_STREAM } }
    );
    console.log(
      `[nats-connections-publisher] 📤 ${constants.CONNECTIONS_NATS_SUBJECT} ` +
        `{ id=${id} } stream=${constants.CONNECTIONS_NATS_STREAM} seq=${pa.seq}`
    );
    return true;
  } catch (err) {
    const e = err as { code?: string | number; message?: string };
    const code = e?.code === undefined ? "" : String(e.code);
    const message = errMsg(err);
    const detail = code ? `code=${code}${message && message !== code ? ` (${message})` : ""}` : message;
    // `503` = no stream / no responder for the subject. That is the documented
    // startup case — the notification worker has not provisioned the stream yet —
    // so log it distinctly instead of as a generic publish failure.
    const unavailable =
      code === "503" || /no responders|no stream|stream not found|expected/i.test(message);
    if (unavailable) {
      console.warn(
        `[nats-connections-publisher] ⚠️ ${constants.CONNECTIONS_NATS_STREAM} stream not usable (${detail}) — ` +
          `dropped { id=${id} }. Start the notification worker; the next connection event re-publishes the same id.`
      );
      return false;
    }
    console.error(
      `[nats-connections-publisher] publish ${constants.CONNECTIONS_NATS_SUBJECT} ` +
        `id=${id} failed (${detail})`
    );
    return false;
  }
}

/**
 * Warm up the NATS connection when the service boots (best-effort).
 * Logs success / failure on the console but NEVER blocks or fails startup.
 */
export function connectNats(): void {
  void getJetStream();
}
