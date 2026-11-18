# World Tensions — Rules and Constants

Every rule below is implemented server-side as a pure function in `/shared`
(no clock, no randomness of its own; time and a seeded RNG are injected) and is
covered by tests in `/tests`. Clients only send intents.

## Time

| Constant | Normal | `DEMO_MODE=true` | Env override |
|---|---|---|---|
| Time scale (game ms per real ms) | 1 | 60 (1 s = 1 game minute) | `TIME_SCALE` |
| Economy tick | 5 game minutes (5 real min) | 5 game minutes (**5 real s**) | `TICK_GAME_MINUTES` |
| Inactivity limit | 72 game hours | 72 game hours (**72 real min**) | `INACTIVITY_GAME_HOURS` |
| Protection period for new countries | 24 game hours | 24 game hours (**24 real min**) | `PROTECTION_GAME_HOURS` |
| Offline catch-up sweep | every 12 due ticks | same | `SWEEP_EVERY_TICKS` |
| Max ticks per catch-up batch | 100,000 | same | `MAX_CATCH_UP_TICKS` |

`DEMO_MODE` defaults to **on** for development servers and **off** when
`NODE_ENV=production`. Source: `shared/config.ts`.

## Countries and territory

- The Earth has 200 generated cells. A **nation** (a governed country) holds one
  or more cells; it is founded on one random free cell (its *home cell*, whose
  flag represents the nation).
- The server always picks the cell. Clients cannot choose or claim one.
- Two cells are **neighbors** if they share a border on the cube map at the
  client's default resolution (1024 px per face). The server computes this graph
  once per Earth, caches it in the database and sends it to clients.

## Starting values (per new nation)

| Value | Rule |
|---|---|
| Treasury | $100,000,000 |
| Population | generated per cell (1.8 M – 42 M) |
| Satisfaction | generated per cell (52 – 88 %) |
| Tax rate | 20 % |
| Natural resources | 4 of the 20-item catalog, generated per cell |
| Production | 30 – 180 units per game hour per resource (seeded per cell) |
| Starting stock | 12 game hours of its own production |
| Military | generated troops (8,000 – 120,000); readiness = generated strength (18 – 64) |
| Housing capacity | 1.3 × the cell's generated population (summed over held cells) |

## Economy tick (Milestone 1 core; extended in Milestone 2)

Per tick, with `h` = tick length in game hours (5/60):

- **Tax income:** `funds += round(population × $2.40 × taxRate% × h)`
- **Production:** `stock[r] += production[r] × h` for each natural resource
- **Population:** `population += round(population × 0.2% × h × (1 − population / capacity))`

## Offline catch-up

- Nations whose governor is online (and bots) are simulated every tick.
- Offline nations are not simulated live. They are caught up **in one batched
  calculation** when the governor reconnects, or by a sweep once 12 ticks are
  due. Batched and tick-by-tick results are identical (tested).
- A server restart counts as being away for governors who were connected.
- On reconnect the governor sees a **"while you were away"** summary: treasury,
  population, satisfaction and stock before and after, plus messages received.
  A reconnect within one tick shows no summary.

## Inactivity

- When a governor's last connection closes, the inactivity clock starts
  (`lastActiveAt`). Everyone sees a countdown on the country profile.
- After 72 game hours offline the nation is **lost**: its cells become free, and
  its treasury and stored resources go to a **random active country** (online,
  bot, or not itself past the limit). The choice uses the server's seeded RNG.
  If no country qualifies, the assets are lost.
- The event goes to the World Log, the audit log and both governors' inboxes.
- Bots and connected governors never expire.
- The governor keeps their name and session and can found a new country through
  the normal random assignment.

## Persistence

- SQLite via `better-sqlite3` behind `Repository` (`server/src/db/repository.ts`).
  Tables: `players`, `sessions` (SHA-256 token hashes only), `countries`,
  `country_resources`, `territory`, `market_offers`, `transactions`, `wars`,
  `world_log`, `audit_log`, `inbox`, `meta`.
- Every action produces one `ChangeSet`. It is committed in a single
  transaction (all or nothing) and only then applied to memory.
- Actions on one Earth run one at a time through a queue.
- An existing `server/data/state.json` from the old prototype is imported once
  into an empty database.

## Audit log

Every server action that changes money or ownership writes an `audit_log` row:
join, rejoin, legacy import, country lost, inheritance, release (dev bots), and
one summary row per economy tick.
