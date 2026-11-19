# World Tensions — Globe + Country View prototype

A browser 3D globe with 200 procedural countries, a server-authoritative world
(SQLite), and a **Country View**: zoom into *your own* country to see its
terrain, build a town, and watch about 40 featured citizens, plus a crowd of up
to 300, react to your government.

```bash
npm install
npm run dev        # server (ws://localhost:8787) + client (http://127.0.0.1:5173), DEMO_MODE on
npm test           # Vitest: rules, persistence, authorization, simulation
npm run e2e        # Playwright: real server + browser, screenshots in screenshots/e2e
npm run shots      # globe screenshots (local preview mode)
```

Join the shared Earth, then click **Enter country** (or double-click your
country, or zoom in close). Press **Esc** or **← Back to globe** to leave.

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    G[Globe<br/>render/globe.ts] -- suspend/resume --> CV[Country View<br/>country/view.ts]
    CV --- T[terrain mesh / water / trees]
    CV --- B[instanced buildings + placement ghost]
    CV --- A[instanced crowd<br/>agents.ts]
    CV --- UI[gov panel · citizen card · news ticker]
    W[(Web Workers)] -- terrain + cube map --> G & CV
    N[NetClient<br/>net/net.ts]
  end
  subgraph Shared ["/shared (pure, deterministic)"]
    TR[country/terrain.ts]
    BL[country/buildings.ts<br/>validatePlacement]
    SIM[country/sim.ts + citizens.ts]
    DLG[country/dialogue.ts]
    PR[protocol.ts validator]
  end
  subgraph Server
    NET[net.ts<br/>rate limit · routing] --> GAME[Game<br/>action queue]
    GAME --> WORLD[World (memory)]
    GAME -- ChangeSet --> REPO[(Repository<br/>SQLite)]
    GAME --> TC[TerrainCache]
  end
  N <-- intents / diffs --> NET
  CV -. same pure code .- TR & BL
  GAME -. same pure code .- TR & BL & SIM & DLG
```

- **Clients send intents only.** Every rule lives in `/shared` as a pure function. Time and a seeded RNG are injected, so the server and tests run the same code.
- **Ordered, atomic actions.** Each Earth runs one action at a time through a queue. An action builds one `ChangeSet`, commits it in a single SQLite transaction, and only then applies it to memory.
- **Private country data.** Buildings, citizens, aggregates, news and policies go **only to the nation's own governors**. No client message can name a nation: the server always uses the sender's own nation.
- **Shared terrain.** Terrain is derived from the public Earth seed. The client and the server generate it with the same function, so the server validates every build against an identical map.

## Message protocol (additions for the Country View)

| Client → server | Purpose |
|---|---|
| `local:open` / `local:close` | subscribe / unsubscribe to **your own** nation's private data |
| `build {kind, i, j, rot}` / `build:cancel {id}` | construction intent (server validates territory, water, slope, overlap, funds, uprising lock) |
| `citizen:ask {id, q}` | preset question id only (no free text) |
| `citizen:release {id}` / `citizen:exile {id}` | justice decision on a detained citizen |
| `policy:tax {rate}` / `policy:services {health, education, police}` / `policy:announce {id}` | government policies (applied next tick) |
| `dev:timescale {scale}` | dev servers only: 60 or 3600 |

| Server → client | Purpose |
|---|---|
| `local:state` | buildings, featured citizens, aggregates (`TownStats`), news, private nation (sent only to its governors) |
| `local:diff` | changed buildings, citizens (throttled to every 1.5 s), stats, private nation, news |
| `build:result`, `action:result`, `citizen:answer` | outcomes |
| `inbox` | live alerts (warnings, completed buildings, detentions, inheritance) |
| `config` | time scale / game-clock anchor after a demo-speed change |

All messages are strictly validated: exact keys, typed values, known ids, and a
2 KB frame limit. They are rate-limited by a token bucket per connection (20
messages, refill 8/s), and malformed frames are counted towards disconnection.

## Simulation rules (summary)

Every constant is documented in `docs/COUNTRY_VIEW.md` and `docs/RULES.md`.

- **Representative town.** Building capacities scale with the founding population. Housing, jobs, food, safety, education, health and leisure coverage come from the finished buildings.
- **Satisfaction target.** 50 minus the tax penalty (0.9 points per % above 25, much steeper above 40), plus or minus housing, jobs, food, safety, services and building bonuses, plus an active announcement. Satisfaction eases 6 % of the gap per game hour.
- **Warnings and uprising.** Warnings at 40 / 30 / 25 %. At ≤ 20 % for 36 ticks, the citizens overthrow the government.
- **Featured citizens.** 40 per country, deterministic. Happiness follows the country plus their traits and circumstances. They complain below 45, protest below 35, plan to move below 25 (after 6 ticks) and leave after 48 ticks. Life events (jobs, children, retirement, tax changes) come from real aggregates.
- **Answers and news state only facts.** Answers are templates filled from real state. News items come only from simulation events.

## Performance

Measured with `npm run e2e` (headless Chromium, 1280×720) from `renderer.info`.
Press **F** in the app for the same numbers live.

| Country view (town, daytime, about 150 citizens out) | Value |
|---|---|
| Draw calls | **47** |
| Instances (trees, buildings, windows, citizens, signs, markers) | **1,944** |
| Triangles | **≈ 342,000** (terrain 256² ≈ 130k plus casters in the shadow pass) |
| GPU geometries / textures while inside | 45 / 8 |
| After 7 enter/exit cycles | geometries back to the globe's 3; textures stay at 4 (one-time three.js shared resource, not per visit) |

**How it stays fast.**
- One InstancedMesh per building kind (body plus windows), trees, citizens (body plus head), protest signs and markers.
- Distant citizens become a point cloud.
- Pixel ratio is capped at 1.5, with one 2048² shadow map.
- The crowd and construction updates reuse preallocated buffers, so no per-frame allocation.
- The globe's render loop is suspended while inside.

**Caveat.** The test machine renders with SwiftShader (CPU), so frame rates from
CI are not meaningful. The **60 FPS at 1080p** target needs confirming on a
mid-range laptop GPU with the F overlay.

## What is intentionally simplified

- **The town stands in for the country.** It is a representative model, not a simulation of millions of individuals; only 40 citizens are tracked individually.
- **The crowd is visual only.** People walk straight lines between building doors and through buildings. Their routine is a seeded schedule; only *what* they do (protest, queue, park visits) comes from the server.
- **The country view is framed on the home cell.** After a conquest, distant exclaves may fall outside the frame.
- **Batched catch-up uses a fixed building list.** Constructions that finish during a long offline batch count from the next live tick.
- **Demo speed is a global dev switch.** It changes the time scale for the whole Earth.
- **Dialogue is templates only.** `DialogueBackend` is the hook for a language model.
- **Market, war and the world log** from the earlier plan are not built yet.

## Path to production

1. **PostgreSQL.** Implement `Repository` (`load` + atomic `commit(ChangeSet)`) with `pg`. ChangeSets map one-to-one onto a transaction. Add row-level locks (`SELECT … FOR UPDATE`) for the cross-nation actions planned next (market, war).
2. **Batching and offline catch-up.** Already in place: offline nations are simulated in one batch on return or in periodic sweeps, and batched equals tick-by-tick. In production, move sweeps to a worker pool and cap batches by wall time.
3. **Spatial streaming.** Private local data is already per nation and on demand (`local:open`). Next steps: stream larger towns in chunks, send citizen deltas instead of full lists, and use binary encoding (MessagePack or flatbuffers) for diffs.
4. **Scaling.** Each Earth is single-writer by design, so shard Earths across server instances. Use Redis pub/sub (or NATS) to fan out public diffs to gateway nodes holding the WebSockets, and a consistent-hash router to send each Earth's intents to its owner instance. Persist audit and news to an append-only store.
5. **Ops.** Add structured logs, metrics (tick duration, queue depth, commit latency), backups of the database, and a migration runner in CI.
