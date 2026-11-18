# Country View

Zooming into **your own** country opens a local view of it. Every constant below
lives in `shared/country/config.ts`; this document lists them with the rule each
one belongs to.

## Entering and leaving

| Entry | Rule |
|---|---|
| "Enter country" (top bar) / "Enter country view" (own profile) | always available for your own country |
| Double-click on the globe | enters only if the cell belongs to your nation; other countries show a notice |
| Zooming in | camera distance < **1.2** planet radii with your country at the screen centre; re-arms after zooming back out past **1.32** |
| Leave | "← Back to globe" button or **Esc** |

The transition takes about **1.2 s**: the globe flies to the country (750 ms, with a
300 ms fade at its end), then the local camera glides down onto the capital
(450 ms). Leaving fades out, then the globe flies back out.

Other countries can never be entered. On the globe they show land and flag only.

## Terrain (`shared/country/terrain.ts`)

The terrain is generated deterministically from the **Earth seed + home cell** (+ the
cells the nation holds). The client and the server run the same pure function, so
both agree on every tile.

| Constant | Value | Meaning |
|---|---|---|
| `size` | 256 | heightfield vertices per side (65,536 tiles) |
| `cellSize` | 1 | scene units per tile |
| `frameMargin` | 1.2 | the square frame is the country's bounding box (tangent plane) × 1.2 |
| `channelWidth` | 2.5 tiles | water channel around the border (the globe's "river" border) |
| `neighborStrip` | 9 tiles | neighbouring land beyond the channel (tinted with that neighbour's flag colour) |
| `frameSamples` | 60,000 | Fibonacci samples used to find the country's centroid and extent |
| `lowland` / `hills` / `mountains` | 0.8 / 5 / 20 | height components (scene units, water level = 0) |
| `coastRamp` | 16 tiles | inland distance over which the relief reaches full height |
| `channelDepth` / `seaDepth` | −1.6 / −3 | channel bed and open sea |
| `riverCount` / `riverDepth` | 3 / 0.7 | rivers that reach a lake or the sea; carve depth |
| `lakeCount` / `lakeRadius` | 2 / 5–9 tiles | interior lakes, blended into the land over 2.6 radii |
| `steepSlope` | 1.6 | height step to a neighbour above which a tile is steep |

**Border.** Each tile's direction on the sphere is scored with the exact
warped-Voronoi rule the globe uses (`shared/country/sampler.ts`). Only cells whose
seed lies within 0.5 rad of the area are scored, which is wider than any cell
reaches. The own-land mask matches the globe's country-ID texture except for
sub-texel slivers (tested: < 3 % at 512 px per face).

**Height.** fbm noise (5 octaves) for hills plus a ridged octave under a mountain
mask. Near the border the profile is continuous: beach → channel bed → neighbour
bank → open sea. A two-pass smoothing band removes stair steps.

**Water.**
- *Lakes* are basins on interior lowland (more than 14 tiles from the border).
- *Rivers* start in the hills (the 12–35th height percentile) and only flow
  downhill, spilling over sills lower than 0.6. A river is kept only if it reaches
  a lake or the sea.

**Biomes** come from the centroid's latitude (warmth), height and a moisture noise:

| Biome | When |
|---|---|
| Sand | own land less than 3 tiles from the coast and lower than 0.6 |
| Snow | above 72 % of the mountain height; above 4 when cold; everywhere when very cold |
| Rock | steep, or above 50 % of the mountain height |
| Desert | warm (warmth > 0.68) and dry |
| Forest | moist |
| Grass | everything else |

In cold countries grass and forest are tinted towards tundra.

**Capital.** A dry tile below the steep threshold that maximises
`inland distance (≤ 24) + 0.8 × distance to lakes/rivers (≤ 12) − 2.5 × height
− 6 × slope − 0.05 × distance from the frame centre`. Towns grow in sheltered
lowland.

**Resource sites.** Each of the nation's four natural resources gets one site,
placed by a seeded search over its own dry land:

| Kind | Resources | Landmark | Placement preference |
|---|---|---|---|
| mine | Coal, Iron Ore, Copper, Bauxite, Gold, Silver, Lithium, Uranium, Rare Earths | ore heaps, headframe, shed | foothills (height ≤ 7), not steep |
| oil | Crude Oil, Natural Gas | derrick, tanks | flat lowland |
| field | Grain, Rice, Cotton, Coffee, Cocoa | crop rows, barn, silo | flat lowland |
| grove | Timber, Rubber | dense trees, sawmill | — |
| pasture | Livestock | animals, barn | flat lowland |
| fishery | Fish | hut, pier, boat | next to open water |

All sites are at least 18 tiles from the capital and apart from each other. The
constraints relax step by step, so every resource always gets a site.

## Rendering (`client/src/country/`)

- **Scene:**
  - one terrain mesh with vertex colours
  - an animated water shader (shore depth texture, waves that fade with distance, foam, opaque deep water)
  - instanced trees (at most 3,200)
  - resource landmarks and a waving flag at the capital
- **Lighting:** a hemisphere light and a sun with 2048² PCF shadows, plus distance fog. ACES tone mapping is enabled only while the view is active.
- **Camera:** an orbit camera with damping and pan.
  - distance 18–260
  - polar angle 0.2–1.32 rad
  - the target is clamped to the country's land
- **Pixel ratio:** capped at 1.5 in the country view (the globe keeps its own cap).
- **Renderer:** the view borrows the globe's renderer. The globe is suspended, so only one loop runs.
- **Exit:** disposes every geometry, material, texture, instanced mesh and the shadow map. The e2e test checks that GPU memory stays flat over repeated enter/exit cycles.

## Buildings (`shared/country/buildings.ts`)

| Building | Cost | Build time (game h) | Upkeep $/game h | Jobs | Homes | Food/h | Service | Satisfaction | Footprint | Max relief |
|---|---|---|---|---|---|---|---|---|---|---|
| House | $800,000 | 6 | 400 | 0 | 6 | — | — | +0.5 | 2×2 | 1.6 |
| Apartment | $3,000,000 | 18 | 1,500 | 2 | 24 | — | — | 0 | 3×3 | 1.4 |
| Farm | $2,500,000 | 12 | 900 | 8 | 1 | 30 | — | 0 | 6×5 | 2.2 |
| Mine | $6,000,000 | 24 | 2,400 | 18 | 0 | — | — | −0.5 | 4×4 | 4 |
| School | $5,000,000 | 24 | 2,000 | 6 | 0 | — | education 60 | +1.5 | 4×3 | 1.4 |
| Market | $4,000,000 | 12 | 1,200 | 10 | 0 | 4 | capacity 80 | +1 | 4×4 | 1.4 |
| Clinic | $6,000,000 | 24 | 2,600 | 8 | 0 | — | health 50 | +2 | 3×3 | 1.4 |
| Park | $1,500,000 | 6 | 300 | 1 | 0 | — | leisure 60 | +1.5 | 5×5 | 2.5 |
| Police Station | $4,500,000 | 18 | 1,800 | 7 | 0 | — | safety 70 | +0.5 | 3×3 | 1.4 |
| Town Hall | (founded with the country) | — | 1,000 | 6 | 0 | — | seat of government | 0 | 5×4 | 2 |

**Construction time.** Real time = `buildHours × constructionFactor × (3,600,000 /
timeScale)` ms.
- Normal mode: `constructionFactor` 1, so a school takes 24 real hours.
- `DEMO_MODE`: `constructionFactor` 0.05 and time scale 60, so a school takes **72 s** and a house **18 s**.
- `CONSTRUCTION_FACTOR` overrides it.

**Placement rules** (`validatePlacement`, used by the ghost preview *and* the
server). Buildings snap to the terrain's tile grid; rotation 0/90° swaps the
footprint. The first failing rule is reported:

1. Known, buildable kind.
2. The footprint lies inside the map.
3. Every footprint tile is **own territory** (not channel, neighbour or sea).
4. No footprint tile is **water** (lake, river).
5. Ground relief across the footprint ≤ the kind's **max relief** (no steep slopes).
6. No **overlap**: one tile of street clearance is kept around every building.
7. Not **locked**: satisfaction ≤ 20 % (the uprising) halts construction.
8. The treasury covers the **cost**.

**Server execution.** `Game.build` runs on the action queue:
- It brings the treasury up to date and validates against the server's own copy of the terrain (same generator, same input).
- It deducts the cost and creates the construction (`status: building`, `completesAt`).
- It writes an audit row with the governor's name.
- The tick completes the construction, sends an inbox message and writes an audit row.

Cancelling a construction in progress refunds **75 %**.

**Starter town.** A new country is founded with a Town Hall at the capital, a
market, five houses, a farm and a park. Each takes the nearest valid spot in a
spiral around the capital (farms at least 8 tiles out). The layout is deterministic.

**Rendering.**
- Each kind is one procedural low-poly model, merged into a body geometry (vertex colours) plus a window geometry, so each kind is two instanced draw calls.
- Construction sites grow from the ground with a scaffold and an HTML progress ring.
- Trees under or next to buildings are hidden.

## Server authority

Terrain derives only from public data (the Earth seed), the same as the globe, so
the client generates it locally.

**Buildings are private.**
- `local:open` subscribes a socket to **its own nation's** data. Country-view messages have no nation-id field, and the validator rejects extra fields.
- `local:state` and `local:diff` go only to sockets whose governor holds that nation. The nation is looked up on every send, so a governor who loses the country stops receiving immediately.
- Cancelling another nation's building answers exactly like a missing one ("No such construction site.").

Tests: `tests/authorization.test.ts` (real WebSocket clients against
`createGameServer`) and `tests/buildings.test.ts`.
