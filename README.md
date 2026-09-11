# QBTCP relay — Cloudflare reference implementation

A tournament-owned Cloudflare Worker and SQLite Durable Object that relays
[QBTCP v1](../../docs/QBTCP.md) with the
[realtime/relay extension](../../docs/QBTCP-STREAM.md) for one tournament.

**This runs in the tournament operator's own Cloudflare account.** QBSheet does not operate it,
has no credentials for it, and does not pay for its traffic. Internet relay load belongs to the
tournament that created it.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gbyo/qbsheet/tree/main/apps/qbtcp-relay-backend-cloudflare)

---

## What it is

One relay deployment per operator; **one Durable Object per active tournament**. Each tournament's
coordination and retained state resolves to one strongly consistent SQLite object, which is what
lets a final reaching the Internet relay and LAN Director within milliseconds retain exactly one
semantic result.

The relay implements the streaming contract from #770 without extending it:

- Discovery advertises the `stream` capability with `retains_finals: true`,
  `mirrors_assignment: true`, `replay: ["sequence", "resync"]`, and no ticket exchange.
- Hibernating WebSockets speak the versioned frame envelope; the first frame authenticates, and
  credentials never appear in the URL.
- Finals are committed to SQLite **before** the receipt is answered. Every relay receipt says
  `received: true`, `review_required: true`, and `accepted_by_director: false` — the relay never
  accepts standings results on Director's behalf.
- Progress is coalesced current-state storage: one row per session, no event, no revision.
- Presence is ephemeral and expiring: one row per room and device, never an event, never
  broadcast.

## Deploying

1. Click **Deploy to Cloudflare** above. Cloudflare clones the repository, reads
   `wrangler.jsonc`, provisions the Durable Object, and deploys.
2. Set the one-time setup token as a secret:

   ```bash
   wrangler secret put RELAY_SETUP_TOKEN
   ```

   Paste any long random string. Director asks for it once and then never needs it again.

3. Copy the deployed Worker URL (`https://qbtcp-relay-backend.<subdomain>.workers.dev`).
4. In Director, paste the URL and the setup token.

Director exchanges the setup token for a durable management credential, stores that credential in
the operating system keychain, and the setup token becomes worthless. It cannot be exchanged
twice. No QBSheet-operated service or credential is involved at any point.

The full operator path — guided setup, claim security, pairing, validation, failure-budget
guidance, safe teardown, and diagnostics — is documented in
[`docs/QBTCP-RELAY-DEPLOY.md`](../../docs/QBTCP-RELAY-DEPLOY.md).

Which browser origins may call authenticated endpoints and open the stream:

```bash
wrangler secret put RELAY_ALLOWED_ORIGINS  # e.g. https://qbsheet.com
```

Requests without an `Origin` (native apps, Director sync jobs) are unaffected. There is no
implicit wildcard — so this is optional only for a relay no browser will ever call. **A browser
scorer needs its own origin listed here**, or every credentialed request it makes is refused 403
`origin_not_allowed` at the preflight, before the real request is ever sent.

Credential-free routes (the root, `/health`, and discovery) are readable by any origin and
advertise only `GET, OPTIONS` with `content-type`. Every other route reads a room token, a session
token, or a management `Authorization`, so it never answers `Access-Control-Allow-Origin: *`: it
echoes an approved origin and nothing else. Preflights for those routes are answered by the same
route table that serves the real request, so the two cannot disagree about what a browser may send.

## Endpoints

Tournament-scoped scorer surface (room token in `x-yf-room-token`, session token in
`x-yf-session-token` — the same header names as local QBTCP, so scorer clients reuse their code):

```
GET  /qbtcp/v1/tournaments/{tournamentId}/discovery
GET  /qbtcp/v1/tournaments/{tournamentId}/assignment
GET  /qbtcp/v1/tournaments/{tournamentId}/assignment/status
POST /qbtcp/v1/tournaments/{tournamentId}/pair
POST /qbtcp/v1/tournaments/{tournamentId}/sessions
GET  /qbtcp/v1/tournaments/{tournamentId}/sessions/{sessionId}
POST /qbtcp/v1/tournaments/{tournamentId}/sessions/{sessionId}/writer
POST /qbtcp/v1/tournaments/{tournamentId}/sessions/{sessionId}/progress
POST /qbtcp/v1/tournaments/{tournamentId}/sessions/{sessionId}/result
GET  /qbtcp/v1/tournaments/{tournamentId}/sessions/{sessionId}/recovery
POST /qbtcp/v1/tournaments/{tournamentId}/presence
GET  /qbtcp/v1/tournaments/{tournamentId}/help
POST /qbtcp/v1/tournaments/{tournamentId}/help
POST /qbtcp/v1/tournaments/{tournamentId}/help/{helpId}/cancel
GET  /qbtcp/v1/tournaments/{tournamentId}/stream            WebSocket
```

Director management surface (`Authorization: Bearer`, never reachable with scorer tokens):

```
POST   /qbtcp/v1/manage/claim
GET    /qbtcp/v1/manage/tournaments/{id}/scorer-readiness
PUT    /qbtcp/v1/manage/tournaments/{id}/mirror
GET    /qbtcp/v1/manage/tournaments/{id}/events?after=&limit=&kinds=
GET    /qbtcp/v1/manage/tournaments/{id}/sessions[?changed_since=]
GET    /qbtcp/v1/manage/tournaments/{id}/results[?state=unacked|all]
GET    /qbtcp/v1/manage/tournaments/{id}/help[?state=open|all]
POST   /qbtcp/v1/manage/tournaments/{id}/acks
POST   /qbtcp/v1/manage/tournaments/{id}/help/{helpId}/resolve
POST   /qbtcp/v1/manage/tournaments/{id}/revoke
POST   /qbtcp/v1/manage/tournaments/{id}/rotate
POST   /qbtcp/v1/manage/tournaments/{id}/close
POST   /qbtcp/v1/manage/tournaments/{id}/chaos      drills only, never production
DELETE /qbtcp/v1/manage/tournaments/{id}
GET    /qbtcp/v1/manage/tournaments/{id}/health
```

`GET .../scorer-readiness` is a narrow, management-authenticated check for the fixed ordinary
Scorer origin `https://qbsheet.com`. It returns only whether that origin is allowed and a corrective
message when it is not; it never returns `RELAY_ALLOWED_ORIGINS` or any credential.

Room and session tokens are relay-minted capabilities for Director-mirrored **identities**: the
room ids, session ids, and match ids are shared with LAN QBTCP so both transports converge on one
logical room, session, and result; the tokens themselves are transport-local. A retry key and a
result fingerprint travel with a submission on either path, so moving a request between transports
never changes its idempotency.

## What it stores

- Director-mirrored rooms (assignment QBJ, pairing-code hashes, revisions) and sessions.
- Relay-minted room/session token **hashes** (sha256; plaintext is never stored).
- One coalesced progress snapshot per session — no per-update event rows.
- Retained finals with their exact QBJ payloads until Director acknowledges ingestion, plus
  retention afterwards. Unacknowledged finals never age out.
- Open help requests until acknowledged; expiring presence rows; a bounded window of
  coordination events (assignment/session/result/help).

It never sees anything else: no standings, no schedule beyond mirrored assignments, no QBLive or
collaboration data.

## Rotating the management credential

`POST manage/rotate` requires the current management credential and returns a fresh one. Only
the new hash is stored: the old credential stops working immediately, mirrored state, retained
finals, and the replay cursor are untouched, and the plaintext leaves the relay exactly once, in
that response. Director stores the new credential in the OS keychain before discarding the old
one.

There is deliberately no "recover with the setup token" path — the setup token is consumed by
the first claim, so a leaked token stays worthless. A Director that has lost its management
credential recovers by exporting any unacknowledged finals (`GET manage/results?state=unacked`),
destroying the tournament (`DELETE manage`), and claiming again with the setup token. Director's
teardown planner refuses a silent destroy while unacknowledged finals remain; see
`docs/QBTCP-RELAY-DEPLOY.md`.

## Failure behaviour and degradation

Every failure is answered with a stable code the scorer and Director degrade from:

| Signal                                           | Meaning                                            | Caller action                                             |
| ------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------- |
| `pairing_refused` (401)                          | Bad/expired/revoked code; identical for all causes | Ask for the code again; never retry blindly               |
| `invalid_credential` (401)                       | Bad room/session/management token                  | Repair the session over HTTP; never delete the local game |
| `conflict` + `can_take_over` (409)               | Another device holds the writer lock               | Take over explicitly, or wait                             |
| `superseded` (410)                               | Stale match, or tournament closed                  | Refetch assignment; keep scoring locally                  |
| `rate_limited` + `retry_after_secs` (429)        | Pairing budget spent                               | Back off with jitter                                      |
| `storage-unavailable` + `retryable: true` (503)  | The relay could not write                          | Keep scoring locally; retry the identical request         |
| `resync-required` frame / `resyncRequired: true` | The stream or replay window has a gap              | Refetch assignment/session state over HTTP                |
| `shutdown` frame `{reason}`                      | Graceful degradation (e.g. tournament closed)      | Degrade to HTTP/LAN, keep scoring                         |
| `origin_not_allowed` (403)                       | Browser origin not on the allowlist                | Fix deployment configuration                              |

When Cloudflare itself refuses operations (Error 1027 and friends), the relay cannot guarantee
service — that is what the scorer's LAN/local fallback is for. The codes above are how QBSheet
recognises the situation early enough to take it.

## Resource budget: why a tournament day fits in Free tier

Published Free limits (September 2026): 100,000 requests/day account-wide, 100,000 Durable
Object requests/day, incoming DO WebSocket messages metered 20:1, 100,000 SQLite rows
written/day, 5M rows read/day.

Worked example — a 60-room tournament, 10 rounds, 12-hour day:

- **Pairing:** 60 rooms × ~3 devices pair once: ~200 requests. Negligible.
- **Stream upgrades:** ~200 connections for the day, held open. 200 metered requests.
- **Assignment pushes:** 10 rounds × 60 rooms = 600 server→scorer frames. Outbound frames do
  not meter as requests; each push costs one event row + one revision write: ~1,200 row writes.
- **Progress:** 60 rooms × 12 h × 720 snapshots/h = ~518,000 snapshots in the absolute worst
  case. Each costs **one row write and zero events** (measured live by
  `rows_per_accepted_progress` in `manage/health`), and arrives as a WebSocket message metering
  20:1: ~26,000 metered requests. Row writes, not requests, are the dimension to watch: 60 rooms
  at a 5 s cadence write 12 rows/s, about 43,000 rows/hour.
- In practice three things share the load: not every room scores simultaneously (byes, breaks,
  lunch), the scorer only sends progress while a game is live, and progress is advisory — the
  push replaces polling, so Director can lengthen the progress cadence once the stream is
  healthy. At a 15 s cadence with 40 live rooms, the day costs ~115,000 rows: near the limit but
  short of it, with `manage/health` showing the burn rate live.
- **The actual limiting dimension is SQLite rows written per day**, driven almost entirely by
  progress cadence × live rooms. Requests are not the limit (pairing, upgrades, pushes, and
  replay cost hundreds of metered requests, not thousands). Storage is not the limit (a retained
  final is kilobytes; 5 GB holds every final of every tournament several times over). Reads are
  not the limit (replay is indexed and bounded; 5M reads cover a Director re-sync every few
  seconds all day).
- If the rows-written pace threatens the limit, the relay degrades the right thing first:
  progress coalesces (dropping cadence loses nothing — the newest snapshot is the whole state),
  while finals and help stay prioritised and durable. Operator guidance: watch
  `rows_written_share` in `manage/health` through the morning; if it climbs past ~0.3 by lunch,
  lengthen the scorer progress cadence in Director.

`GET manage/health` reports the measured counters (`rows_written_estimate`,
`metered_requests_estimate`, `rows_per_accepted_progress`), the storage pressure
(`results_unacked`, `help_open`, `events`), and the headroom shares against the limits above.
Where Cloudflare exposes no reliable pre-limit quota API, the relay reports its own estimates
and says so — it never pretends an exact remaining quota is known.

## Development

```bash
npm install
npm test          # runs inside real workerd against the real wrangler.jsonc
npm run typecheck
npm run dev
```

`src/protocol/` implements the #770 contract inline (rather than importing it) so this directory
is self-contained and deployable straight from the repository — "Deploy to Cloudflare" cannot
resolve monorepo workspace packages. Drift is prevented structurally: `test/relay.test.ts`
validates the relay against the canonical fixtures in `tests/fixtures/qbtcp-stream/`, which the
#770 TypeScript and Rust suites also read. If the contract moves and the relay does not follow,
that suite fails.

The transport-neutral conformance harness in `packages/qbtcp-relay-conformance` runs the same
expectations against any relay implementation, Cloudflare or otherwise.
