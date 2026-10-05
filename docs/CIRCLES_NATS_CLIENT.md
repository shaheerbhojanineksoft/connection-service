# Circles — NATS Client-Side (Consumer) Implementation Guide

Everything a **client** (any service that consumes the circles event bus) needs to
subscribe to, validate, and apply the circle events published by
**connection-service**.

> Producer: `connection-service` (Circles feature) → JetStream **SOCIAL** stream.
> Reference consumer already shipped: `feed-data-sync-service` (`social-graph-sync`).
> Verified end-to-end (see [§7](#7-verification)).

---

## 1. Flow

```
connection-service (producer)                     your client (consumer)
─────────────────────────────                     ───────────────────────
POST   /circles            ─┐                      SOCIAL stream (JetStream)
PUT    /circles/:id         │                       │  durable consumer
DELETE /circles/:id         │  publish AFTER        │  (ack explicit)
POST   /circles/:id/addmember│   the Mongo commit   │        ↓
PUT    /circles/:id/removemember                      dispatch by subject
                            └► social.circle.*  ──►        ↓
                                                      idempotent upserts
```

Publishes are **best-effort** (fire-and-forget, never throw, never block the
request). The Mongo write always happens first — a NATS outage only means the
client misses an event, never that the API fails.

---

## 2. Event contract

Stream: **`SOCIAL`** (JetStream, `RetentionPolicy.Limits`).

| Subject | When | Payload |
|---|---|---|
| `social.circle.created` | circle created | `{ circleId, name, mts }` |
| `social.circle.updated` | circle renamed / recolored | `{ circleId, name, mts }` |
| `social.circle.deleted` | circle soft-deleted | `{ circleId, mts }` |
| `social.circle.member.added` | member(s) added | `{ circleId, userId, mts }` |
| `social.circle.member.removed` | member(s) removed | `{ circleId, userId, mts }` |

Field notes:

- `circleId` — UUID v4 string (`_id` of the circle document), **not** a Mongo ObjectId.
- `userId` — the **member** being added/removed (Keycloak id).
- `mts` — publisher epoch-millis (optional; informational).
- **`member.added` is also emitted for members passed at creation time** — one event
  per initial member, right after `circle.created`. If you only handled the
  `:id/addmember` route you would miss the initial members.

### TypeBox schemas (drop-in)

```ts
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

export const CircleCreatedEventSchema = Type.Object({
  circleId: Type.String({ minLength: 1 }),
  name: Type.String(),
  mts: Type.Optional(Type.Number()),
})
export const CircleUpdatedEventSchema = Type.Object({
  circleId: Type.String({ minLength: 1 }),
  name: Type.String(),
  mts: Type.Optional(Type.Number()),
})
export const CircleDeletedEventSchema = Type.Object({
  circleId: Type.String({ minLength: 1 }),
  mts: Type.Optional(Type.Number()),
})
export const CircleMemberEventSchema = Type.Object({
  circleId: Type.String({ minLength: 1 }),
  userId: Type.String({ minLength: 1 }),
  mts: Type.Optional(Type.Number()),
})

export const isValid = (schema: import('@sinclair/typebox').TSchema, data: unknown) =>
  Value.Check(schema, data)
```

---

## 3. Consumer configuration

| Item | Value | Notes |
|---|---|---|
| Stream | `SOCIAL` | shared with `social.followed`, `social.blocked`, … |
| Durable | **you choose** | feed-data-sync uses `social-graph-sync` |
| `ack_policy` | `explicit` | ack only after your write commits |
| `deliver_policy` | `all` | a fresh durable replays history |
| `max_deliver` | `1` | no redelivery — failures go to the DLQ |
| DLQ subject | `social.dlq` | route poison messages here |

⚠️ The `SOCIAL` stream carries **all** social events, not just circles. A
circle-only consumer should **filter** to the five subjects above
(`filter_subjects`), otherwise it will also receive follow/block/symbol events
and must ack-and-ignore them. (The reference `feed-data-sync` consumer is
filter-less because it has handlers for every subject.)

```ts
const CIRCLE_SUBJECTS = [
  'social.circle.created',
  'social.circle.updated',
  'social.circle.deleted',
  'social.circle.member.added',
  'social.circle.member.removed',
]
```

---

## 4. Delivery semantics you must code against

1. **At-most-once from the producer.** Publish happens *after* the DB commit but
   is fire-and-forget. If NATS is down the event is lost (logged on the producer).
2. **Ordering is preserved per stream.** For a create-with-members you always get
   `circle.created` *before* its `member.added` events. Later mutations arrive in
   order.
3. **Make every handler idempotent (upsert).** Because a durable can replay from
   `deliver_policy: all`, and because re-publishing the same operation is safe.
   Use "ensure/upsert" semantics, never blind increments.
4. **Ack only after the write succeeds.** On failure, log to your errors/DLQ and
   ack (or `nack` if you configure retries). Do **not** leave the message
   un-acked expecting redelivery — `max_deliver` is 1.

### Event → action mapping (idempotent)

| Event | Action |
|---|---|
| `circle.created` | upsert circle node `{ id: circleId, name }` |
| `circle.updated` | upsert circle node with the new `name` |
| `circle.deleted` | delete circle node **and** all its membership edges |
| `circle.member.added` | ensure circle node + user node, then upsert edge (circle → user) |
| `circle.member.removed` | delete edge (circle → user) |

---

## 5. Reference client implementation (Bun + TypeScript)

Self-contained consumer. Replace the `store` methods with your own storage.

```ts
import { connect } from '@nats-io/transport-node'
import {
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  jetstream,
  jetstreamManager,
} from '@nats-io/jetstream'
import { Value } from '@sinclair/typebox/value'

import {
  CircleCreatedEventSchema,
  CircleDeletedEventSchema,
  CircleMemberEventSchema,
  CircleUpdatedEventSchema,
} from './schemas' // the schemas from §2

const STREAM = 'SOCIAL'
const DURABLE = 'my-circle-consumer'
const DLQ = 'social.dlq'
const SUBJECTS = [
  'social.circle.created',
  'social.circle.updated',
  'social.circle.deleted',
  'social.circle.member.added',
  'social.circle.member.removed',
]

// ── your storage (idempotent upserts) ───────────────────────────────────────
const store = {
  async upsertCircle(circleId: string, name: string) {
    /* await db.circles.updateOne({ id: circleId }, { $set: { id: circleId, name } }, { upsert: true }) */
  },
  async deleteCircle(circleId: string) {
    /* await db.circles.deleteOne({ id: circleId }); await db.members.deleteMany({ circleId }) */
  },
  async addMember(circleId: string, userId: string) {
    /* await db.members.updateOne({ circleId, userId }, { $set: { circleId, userId } }, { upsert: true }) */
  },
  async removeMember(circleId: string, userId: string) {
    /* await db.members.deleteOne({ circleId, userId }) */
  },
}

async function dispatch(subject: string, data: unknown): Promise<void> {
  switch (subject) {
    case 'social.circle.created':
      if (!Value.Check(CircleCreatedEventSchema, data)) throw new Error('invalid payload')
      return store.upsertCircle(data.circleId, data.name)
    case 'social.circle.updated':
      if (!Value.Check(CircleUpdatedEventSchema, data)) throw new Error('invalid payload')
      return store.upsertCircle(data.circleId, data.name)
    case 'social.circle.deleted':
      if (!Value.Check(CircleDeletedEventSchema, data)) throw new Error('invalid payload')
      return store.deleteCircle(data.circleId)
    case 'social.circle.member.added':
      if (!Value.Check(CircleMemberEventSchema, data)) throw new Error('invalid payload')
      return store.addMember(data.circleId, data.userId)
    case 'social.circle.member.removed':
      if (!Value.Check(CircleMemberEventSchema, data)) throw new Error('invalid payload')
      return store.removeMember(data.circleId, data.userId)
    default:
      return // not ours
  }
}

async function main() {
  const nc = await connect({ servers: process.env.NATS_URL ?? 'nats://localhost:4222' })
  const js = jetstream(nc)
  const jsm = await jetstreamManager(nc)

  // Provision the stream (idempotent) — or let the owner create it.
  try {
    await jsm.streams.info(STREAM)
  } catch {
    await jsm.streams.add({ name: STREAM, subjects: ['social.>'], retention: RetentionPolicy.Limits })
  }

  // Durable consumer, filtered to circle subjects.
  try {
    await jsm.consumers.add(STREAM, {
      durable_name: DURABLE,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      max_deliver: 1,
      filter_subjects: SUBJECTS,
    } as never)
  } catch {
    /* already exists */
  }

  const consumer = await js.consumers.get(STREAM, DURABLE)
  const messages = await consumer.consume({ max_messages: 16 })

  for await (const m of messages) {
    try {
      const data = JSON.parse(new TextDecoder().decode(m.data))
      await dispatch(m.subject, data)
      m.ack()
    } catch (err) {
      console.error(`[circles] failed ${m.subject}:`, err)
      nc.publish(DLQ, m.data) // poison message → DLQ
      m.term()                // remove it so it is not redelivered
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

---

## 6. Producer reference (where events are emitted)

`connection-service` — publish happens **after** each Mongo write commits, in
`src/services/circles.service.ts`:

| Service function | Published event(s) |
|---|---|
| `addCircle` | `created`, then one `member.added` per initial member |
| `editCircle` | `updated` |
| `deleteCircleById` | `deleted` |
| `addCircleMember` | one `member.added` per **newly** added member |
| `removeCircleMember` | one `member.removed` per removed member |

Publisher module: `src/services/nats.publisher.ts`. Subjects/env overrides:
`src/config/constants.ts` (`SOCIAL_CIRCLE_*_SUBJECT`).

---

## 7. Verification

Full flow tested against an isolated JetStream server, driving the **real**
`connection-service` service functions (throwaway DB) and the **real**
`feed-data-sync-service` consumer stack (router + handlers + NATS manager) with a
stub storage layer recording every write:

| # | Action | Produced subject | Client write (expected) | Result |
|---|---|---|---|---|
| 1 | create circle (2 members) | `social.circle.created` | `createCircle(id, "Circle A")` | ✅ |
| 2 | ″ | `social.circle.member.added` | `addCircleMember(id, u-1)` | ✅ |
| 3 | ″ | `social.circle.member.added` | `addCircleMember(id, u-2)` | ✅ |
| 4 | rename | `social.circle.updated` | `updateCircleName(id, "Circle B")` | ✅ |
| 5 | add member | `social.circle.member.added` | `addCircleMember(id, u-3)` | ✅ |
| 6 | remove member | `social.circle.member.removed` | `removeCircleMember(id, u-1)` | ✅ |
| 7 | delete circle | `social.circle.deleted` | `deleteCircle(id)` | ✅ |

```
CALL_COUNT=7   (all events consumed, ordered, schema-validated)
```

Re-run locally:

1. Start a JetStream server: `docker run -d --name nats -p 4222:4222 nats:alpine -js`
2. Start your consumer against `NATS_URL=nats://localhost:4222`.
3. Drive the producer (`POST/PUT/DELETE` on `/connection/circles…`) or replay
   events with `nats pub social.circle.created '{"circleId":"c1","name":"Test"}'`.

---

## 8. Gotchas checklist

- [ ] Handle **both** `circle.created` **and** its follow-up `member.added` events for initial members.
- [ ] Implement `social.circle.updated` — a rename emits it; ignore it and your copy keeps the old name.
- [ ] Filter to circle subjects (the SOCIAL stream carries other social events).
- [ ] Use upserts — durables replay from the beginning.
- [ ] Ack after the write; route poison messages to `social.dlq`.
- [ ] Treat `circleId` as a UUID string, never as a Mongo ObjectId.
