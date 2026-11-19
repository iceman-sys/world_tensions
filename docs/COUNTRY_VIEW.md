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

## Country simulation (`shared/country/sim.ts`)

The town is a **representative model** of the whole country. Building capacities
are scaled by the country's founding population, so the starter town covers it
at the reference ratios. Building more raises coverage proportionally. Every
tick (5 game minutes) the server computes:

| Aggregate | Rule |
|---|---|
| Housing capacity | homes ÷ starter homes × **1.05** × founding population (population grows towards it) |
| Workforce / jobs | workforce = **55 %** of the population; jobs = jobs ÷ starter jobs × **0.85** × founding workforce |
| Employment | jobs ÷ workforce (0–100 %) |
| Tax income | the economy core's income × (0.5 + 0.5 × employment) |
| Upkeep | sum of finished buildings' upkeep (services switched off cost nothing) |
| Food | farms + markets + **6/h** per food resource (Grain, Rice, Fish, Livestock, Cocoa, Coffee) − **30/h** × population ÷ founding population. A **shortage** is an empty store with a negative balance. Countries start with 24 h of food. |
| Safety | 0.5 + police coverage × 0.5 (coverage = capacity ÷ (need × population ratio), needs: safety 140, education 120, health 100, leisure 60) |

**Satisfaction target** (0–100):

```
50
− taxPenalty            (tax − 25) × 0.9  +  max(0, tax − 40)^1.5 × 0.35
+ housing               clamp((housing − 1) × 30, −20, +3)
+ jobs                  clamp((employment − 0.9) × 40, −20, +4)
+ food                  −18 in a shortage, +3 with a surplus
+ safety                (safety − 0.5) × 14
+ services              education × 4 + health × 5 + leisure × 4
+ buildings             sum of building satisfaction bonuses (max +8)
+ announcement          while a policy announcement is active
```

Satisfaction moves **6 % of the gap per game hour** towards the target.

- **Migration:** below **25 %** the population shrinks by up to 0.4 % per game hour.
- **Warnings:** inbox alerts at **40 %, 30 %, 25 %**, each sent once. They re-arm after satisfaction recovers above 45 %.
- **Uprising:** at or below **20 %** for **36 consecutive ticks** (3 game hours) the citizens overthrow the government. The country is lost through the same rule as inactivity (its assets go to a random active country, logged and audited), and the governor can found a new country. Construction is locked while satisfaction is at or below 20 %.

Offline countries are caught up in one batch; the batch equals tick-by-tick,
including citizens (tested). Constructions finishing during a long batch count
from the next tick (simplification).

## Featured citizens (`shared/country/citizens.ts`)

Each country has **40 featured citizens**, generated deterministically from the
Earth seed and the nation. They are about 20 % children, 65 % working age and
15 % retired.

**Profile.**
- name (syllable generator), age, job (from the workplace), take-home income (gross pay × (1 − tax); pensions and benefits are untaxed), education
- family (partner and children by name), home building
- **3 traits** from 12, happiness, loyalty, opinion of the government
- current need, status, notable role, and a life history (last 12 events)

**Each tick** (per-tick RNG seeded by seed, nation and tick time):

| Rule | Detail |
|---|---|
| Happiness target | national satisfaction ± traits (frugal: tax; family-oriented: housing and food; ambitious / hard-working: jobs; cautious / worried: safety; cheerful +6; grumpy −6; …) − 12 if unemployed − 10 if homeless; eases at 12 % of the gap per game hour |
| Opinion | (happiness − 50) × 1.6 + (loyalty − 50) × 0.6, clamped to ±100 |
| **Status** | complaining < **45**, protesting < **35**, planning to move after **6** ticks < **25**, **leaves** after **48** ticks < 25 |
| Life events | aging (1 year per game day), retirement at 67, finishing school at 18, getting or losing a job (by employment), a new home, children (partner, age 22–44, happy, no shortage), "Lost income after the tax rose to X %" when the tax changes by 5 or more points |
| Newcomers | when satisfaction > 55 and housing ≥ 0.95 |
| Justice | a citizen can be **detained** only under real hardship: age 16+, happiness < 30, and a food shortage or safety < 0.45 |

**Justice decisions** (governor; audited with their name):

| Decision | Effect |
|---|---|
| Release | citizen loyalty +10, happiness +5; country satisfaction **+0.5** |
| Exile | citizen removed; country satisfaction **−1.5** |

## Conversations (`shared/country/dialogue.ts`)

There is **no free-text input**. The client sends a preset question id; the
protocol validator rejects anything else. The questions are:
- How are you feeling?
- Do you have enough food?
- What do you think about taxes?
- Do you have a good job?
- Would you consider moving away?
- How is your home?
- Do you feel safe?

The server answers with `TemplateBackend`, which composes mild sentences from the
citizen's traits and the **real** state: the exact tax rate and take-home pay,
whether food is short or running down, the employment rate, the citizen's home
and workplace, and police coverage. A different source (e.g. a language model)
can implement `DialogueBackend`, but only templates ship.

## Crowd rendering (`client/src/country/agents.ts`)

- **Count:** visible citizens = clamp(120 + population ÷ 150,000, **150, 300**).
- **Rendering:** two InstancedMeshes (body, head), plus protest signs, featured markers and a point cloud for distant citizens.
- **Level of detail:** within camera distance 70 everyone is a figure; between 70 and 150 figures fade into dots; beyond 220 only 60 % are drawn.
- **Daily routine** (game clock):
  - leave home at 6–7:36
  - work until 16–17:30
  - market or park until 19:30–21:30
  - home at night; windows glow, and 8 % walk at night
- **Reactions** (only from server state):
  - **protest:** the share of featured citizens protesting or planning to move × crowd × 0.6 people gather with signs at the town hall
  - **food shortage:** a 22-person queue at the market
  - **mood:** at satisfaction ≥ 65, 75 % spend the evening in the park (40 % at ≥ 45, 15 % below)
- **Performance:** all buffers are preallocated; `update()` does not allocate.

## Government panel and feedback loop (CV4)

| Control | Message | Rule |
|---|---|---|
| Tax slider | `policy:tax {rate}` | integer **0–60 %**; stored as *pending* and applied at the start of the **next tick** (also inside a batched catch-up) |
| Public services | `policy:services {health, education, police}` | switching one off zeroes its coverage (health, education; safety falls back to 0.5) and stops its buildings' upkeep, from the next tick |
| Announcements | `policy:announce {id}` | preset messages only. One at a time. Each adds a documented bonus to the satisfaction target for a few game hours. |
| Demo speed (dev servers) | `dev:timescale {scale}` | 60 (1 s = 1 game minute) or 3600 (1 s = 1 game hour). The game clock stays continuous (anchor `clockReal` / `clockGame`). |
| Scenario | (client) | sends the normal intent `policy:tax 60` (plus demo speed on dev servers); the citizens react within about 30 s |

All of them are audited with the governor's name. Tax and service changes also
produce a factual news item.

| Announcement | Effect |
|---|---|
| "The government thanks every citizen for their hard work." | +2 for 6 game hours |
| "The government will review taxes next season." | +3 for 6 game hours |
| "New farms are planned to keep the market stocked." | +2 for 8 game hours |
| "More patrols will keep neighbourhoods safe." | +2 for 8 game hours |

**Feedback.**
- **Sparklines:** population, satisfaction, employment and treasury, from the server's per-tick history (last 60 ticks).
- **Warning stages:** 40 / 30 / 25 % produce inbox alerts (delivered live) and an unrest level in the panel. The scene gets a red vignette that strengthens with each stage, and protest crowds form when citizens protest.
- **Uprising:** at ≤ 20 % for 36 ticks the government falls and the uprising screen offers "Found a new country".

**Country News** (`news` table, private to the nation). The ticker shows only
items the server created from simulation events or government actions. Each is
labelled **FACT**; anything else would be labelled FLAVOR (none ship). Events:
- tax and service changes, announcements
- satisfaction warnings
- food shortage and recovery
- protests (summarised at most every 2 game hours, with the real count)
- citizens leaving or arriving
- detentions, releases and exiles
- completed buildings (inbox)

## Server authority

Terrain derives only from public data (the Earth seed), the same as the globe, so
the client generates it locally.

**Buildings are private.**
- `local:open` subscribes a socket to **its own nation's** data. Country-view messages have no nation-id field, and the validator rejects extra fields.
- `local:state` and `local:diff` go only to sockets whose governor holds that nation. The nation is looked up on every send, so a governor who loses the country stops receiving immediately.
- Cancelling another nation's building answers exactly like a missing one ("No such construction site.").

Tests: `tests/authorization.test.ts` (real WebSocket clients against
`createGameServer`) and `tests/buildings.test.ts`.
