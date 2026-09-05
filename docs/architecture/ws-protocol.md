# WebSocket Protocol — carta-realtime ↔ frontend-renderer

Version: 1 (see `PROTOCOL_VERSION` in `services/realtime/src/types.ts`)

## Transport

- Endpoint: `ws://<host>:8080/ws` (behind Cloudflare Tunnel in production:
  `wss://ws.carta-para-isa.<your-domain>/ws`)
- Subprotocol: none (plain WebSocket frames)
- Encoding: **MessagePack** (binary frames, via `msgpackr`). Server → client
  frames are always msgpack. The client may send a few control messages
  (`subscribe`, `ack`) as JSON; `serialization.ts` decodes either. See
  `services/realtime/src/serialization.ts`.
- Beyond the snapshot/delta below, the server also supports **viewport
  streaming** (the client subscribes to chunks near its camera) and **birth
  events** for the infinite chunk-native world. See `docs/architecture/INFINITE_WORLD.md` §4–5.

## Message direction

```
server → client: SnapshotMessage | DeltaMessage | ErrorMessage
client → server: AckMessage | ClientInputMessage
```

## Server → Client messages

### SnapshotMessage

Sent immediately when a client connects. Also broadcast periodically (every
1500 ticks = 30 s) after a snapshot is persisted to disk.

```json
{
  "type": "snapshot",
  "protocolVersion": 1,
  "tick": 1500,
  "simulatedMs": 30000,
  "world": { ... }
}
```

- `world`: full ECS world state (shape TBD with simulation-engineer; currently
  a placeholder object).
- The client should reset its local render state on receiving a snapshot.

### DeltaMessage

Sent every tick (20 ms) to all connected clients.

```json
{
  "type": "delta",
  "protocolVersion": 1,
  "tick": 1501,
  "events": [ ... ],
  "components": {
    "clock": { "tick": 1501, "simulatedMs": 30020 },
    "steven.Homeostasis": { "energy": 0.87, "bond": 0.92, "mood": 0.3, "heartRate": 72 }
  }
}
```

- `events`: array of `SimEvent` objects emitted this tick (BondGained,
  DeathByDisconnection, etc.). Only events newer than the client's last `ack`
  tick are included.
- `components`: map of `entityId.ComponentKind` to changed component data.
  Only components that changed since the previous tick are included.
- The client applies deltas on top of the last received snapshot.

### ErrorMessage

```json
{
  "type": "error",
  "code": "RATE_LIMIT_EXCEEDED",
  "message": "Too many input events per second"
}
```

## Client → Server messages

### AckMessage

The client should send an ack after processing each delta (or every N deltas
to reduce traffic). The server uses `upToTick` to filter events in future
deltas — events older than `upToTick` are not re-sent.

```json
{ "type": "ack", "upToTick": 1501 }
```

### ClientInputMessage

Sent when Isa interacts with the world. Rate-limited to 10 inputs/second
server-side. Excess inputs are silently dropped.

```json
{
  "type": "input",
  "action": {
    "kind": "Interact",
    "entityId": "isa",
    "targetEntityId": "steven",
    "payload": { "text": "te amo" }
  }
}
```

- `action` shape matches the `Action` discriminated union from `sim-core`.
  Currently a passthrough `unknown`; will be validated against the sim-core
  types once the contract is stable (coordinate with simulation-engineer).

## Connection lifecycle

```
Client                          Server
  |                               |
  |── TCP connect ───────────────>|
  |── HTTP Upgrade /ws ──────────>|
  |<── 101 Switching Protocols ───|
  |<── SnapshotMessage ───────────|  immediate on connect
  |                               |
  |<── DeltaMessage (tick N+1) ───|  every 20 ms
  |── AckMessage (upToTick N+1) ->|  after processing delta
  |<── DeltaMessage (tick N+2) ───|
  |   ...                         |
  |── ClientInputMessage ─────────>|  when Isa interacts
  |                               |
  |<── SnapshotMessage ───────────|  every 30 s (post-persist broadcast)
  |                               |
  |── WS Close (1001) ───────────>|  client disconnect
  |                               |
  |   [SIGTERM]                   |
  |<── WS Close (1001) ───────────|  graceful shutdown
```

## Versioning

`protocolVersion` is a monotonically increasing integer. When the wire format
changes in a breaking way:
1. Increment `PROTOCOL_VERSION` in `services/realtime/src/types.ts`.
2. The client must check `protocolVersion` on receipt of the first snapshot;
   if it does not match the expected version, it should disconnect and show an
   "update required" message.
3. Non-breaking additions (new fields, new event kinds) do not require a
   version bump — clients should ignore unknown fields.

## Encoding (shipped)

Server → client frames are **MessagePack** binary frames (`msgpackr`), not text
frames. There is no hello/negotiation handshake: the wire is binary by default.
The client may send a few control messages (`subscribe`, `ack`) as JSON, which
the server decodes via a JSON fallback in `serialization.ts`. The JSON examples
in this document describe the *shape* of each message, not the on-wire encoding.

## Single-room design

There is exactly one simulation world. All connected clients observe the same
state. There is no room selection, authentication, or multi-tenancy. The carta
is for Isa — one world, one love.
