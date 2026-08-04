# house measurer

Browser-based room measurement and layout tool for surveying an old stone
building with a cheap laser distance measurer. Points are fixed by
trilateration - two distances from two already-fixed points - so rooms with
no right angles, alcoves and chimney breasts come out true. Entirely
client-side, state in localStorage, no build step.

## Measuring

1. Mark two anchor points A and B (ideally room corners) with tape crosses.
   Measure A to B, type it in, press OK. The baseline renders immediately
   and starts the wall outline.
2. For each new point: tap two already-fixed points, type the measured
   distance to each, press OK (OK on the first field jumps to the second).
   Both candidate positions are shown while you type - OK places the marked
   one, tapping the other candidate places that one instead, and the flip
   key swaps the last point afterwards.
   Up to **four** references can be selected for one point: distances are
   then entered one at a time (laser auto mode shoots them in sequence)
   and commit together - the first two form the fix, the extras join the
   least-squares adjustment immediately, so noise averages down, a bad
   reading shows as a residual instead of silently shifting the point,
   and the mirror ambiguity resolves itself from the third distance.
   More references genuinely help; what matters most is spreading them in
   direction (rays crossing at 60-120 degrees) - three references in a
   narrow fan are barely better than two.
3. Until the first room is closed, every committed point chains into the
   wall outline automatically - measure the corners in order round the
   room, then press **close room** and type the ceiling height (stored per
   room; each closed loop keeps its own). A wrong chain link is fixed in
   walls mode with step back. After the first room, new points are
   unspecified and walls are drawn explicitly.
   When the anchors fall out of sight partway round (an L-shaped room, a
   chimney breast), pause the auto-chain with **walling: on/paused**,
   place reference-only points where you can see both anchors, resume,
   and carry on measuring corners from the new references. A point that
   mistakenly joined the outline is fixed by selecting it and pressing
   **unwall**: the loop reroutes past it and the point survives as a
   reference. Deleting a measurement that a point's fix depends on warns
   first and names every point it would unsolve.
4. Redundancy: select two existing points, type the measured distance,
   press **record**. All positions are least-squares adjusted over every
   measurement; residuals show per point on the plan and per measurement in
   the data sheet (green < 1 cm, amber < 3 cm, red beyond). Nothing is
   silently discarded - every measurement can be edited or deleted there
   and the solution recomputes live. The **detail** button on the plan
   overlays the interior angle at every wall corner (reflex corners like
   chimney breasts read > 180) and the construction circles behind the
   last or any single selected point; while typing a new point, the angle
   the proposed wall would make with the run previews live. Points whose
   two fix rays meet at a poor angle (under 30 or over 150 degrees) get a
   "fix N°" badge: their circles cross at a glancing angle, so laser
   noise is amplified into position error that no residual can reveal -
   re-fix such points from a better-spread reference pair, or tie them
   down with a recorded check measurement.
5. Measuring also works inside the 3D view: the survey pins are tappable
   as references, candidates appear as pillars, and the measurement
   circles draw across the floor.

## Floors and stairs

All floors share one plan coordinate system; a floor only adds an
elevation. Add a floor in the data sheet (the initial floor-to-floor
number is just a placeholder - you will rarely know it). Derive the real
value with the **floor-to-floor calculator** in the data sheet: riser
count x riser height with optional odd first/last risers (old staircases
are rarely uniform), or ceiling height at the stairwell + the floor
build-up measurable at the opening's trimmer. Either sets the floor's
elevation in one tap. To anchor the new floor, tap a ghosted
point from the floor below that sits directly beneath a usable spot
(stairwell corner, external wall corner - or drop a plumb line) and press
**stack here**: a twin point is pinned at the same plan position on the
new floor. Stack two, then measure the whole floor from them exactly as
downstairs - auto-walling, close room and per-room ceilings all work per
floor. The solver treats a stacked twin and its origin as the same 2D
unknown, so redundant measurements tighten both floors together. The
floor chip beside the mode bar switches floors; the plan ghosts the other
visible floors underneath for alignment, and 3D stacks everything at its
real elevation (upper rooms get a visible floor build-up slab).

Stairs are an item category: width = the flight's horizontal run, depth =
stair width, height = total rise (default the floor-to-floor height).
Risers are derived at ~18 cm; the flight renders as real steps in 3D and
with tread lines in plan, ascending along the item's long axis. Measure a
staircase with the builders' method - count risers, measure one riser,
one going and the width; the total rise should match the floor-to-floor
offset, which is your cross-check. An L-shaped stair is two flights plus
a landing ("other" item).

Raised floor sections (a stepped-up corner of a room, a hearth plinth)
are the **raised floor** item category: a platform with a plank top and
timber edges, placed and measured like any other item - two distances to
a corner, or corners tapped from measured points.

Units: a number **with** a decimal point is metres, **without** is
centimetres. `342` = 3.42 m, `3.42` = 3.42 m, `84` = 84 cm. For a whole
number of metres add a trailing dot: `15.` = 15 m. Comma works as a decimal
separator. The interpreted value is always shown under the field before you
commit.

## Walls, items, layers, 3D

- **walls** mode: tap points in sequence to draw wall polylines; tapping
  the wall's first point again closes the room outline (the closed room is
  shaded, and gets a floor in 3D).
- **items** mode: create named items (width x depth x height, category
  colour, presets for fridges, worktops, windows, doors, hoods...). Place
  them three ways: by two measured distances to a corner (then a second
  corner, a tap on a wall to align, or OK to keep the item's width); on a
  wall with an offset from a wall end (windows, doors, radiators, shelves,
  hoods - they take a height above floor and render there in 3D); or just
  drop them in the view.
- **move** mode: tap an item to select, drag to move, drag the handle to
  rotate (snaps to walls and 15-degree steps), flip = rotate 90 degrees,
  lock protects measured positions.
- Every item lives on a layer: "current" or any number of named proposal
  layers (log sheet: add, show/hide, set active) - so the room today can be
  compared against planned layouts.
- The **3D** button toggles an extruded perspective view: walls to the room
  height (default 2.6 m, editable in the log sheet), orbit/pinch controls.
  Rendering is PBR with soft shadows, environment light and procedural
  canvas textures (plank floor, plaster, cupboard fronts, appliance faces
  by name - fridge/washer/oven, radiator fins), all generated at runtime so
  the app stays offline. Windows and doors cut real openings through the
  walls and render as frame + glass / slab + knobs; hoods get a funnel and
  chimney; skirting runs along the walls. Dollhouse cutaway: whichever
  walls stand between the camera and the room interior fade to translucent
  as you orbit (windows and doors in a faded wall hide with it), so the
  inside is always visible.
- The **data** sheet is the interface to everything recorded: measurements
  (edit/delete with live residuals), walls and rooms (per-room ceiling
  heights), layers, and JSON export/import (download, copy to clipboard,
  paste or file) for backup and moving between devices. Multiple rooms are
  just multiple closed loops - measure through doorways to chain the next
  room's points off the first room's, and the gap between back-to-back
  walls is simply whatever you measure it to be.

Every commit is undoable (undo history survives reloads) and everything
autosaves to localStorage on every change. "clear everything" lives behind
the ? help panel and needs a second confirming tap.

## Running / developing

Static files, native ES modules, no build. Serve the directory over HTTP
(module imports do not work from file://):

    ./serve.py          # http.server + no-cache headers, port 8017
    # open http://localhost:8017

Use serve.py rather than plain `python3 -m http.server`: without no-cache
headers the browser caches the ES modules on heuristic freshness and code
changes appear to "not take" until a hard reload. (GitHub Pages sends
proper validators, so production does not have this problem.)

Tests (pure geometry, least-squares and store logic, no browser needed):

    node --test test/geometry.test.mjs test/adjust.test.mjs

End-to-end browser test (drives the real UI in headless Chrome - keypad,
canvas taps, walls, items, 3D, import/export - and saves screenshots; see
the header of the file for usage):

    node test/browser-drive.mjs

three.js v0.164.1 and its OrbitControls are vendored and pinned in
`vendor/` (MIT - see `vendor/three.LICENSE`). No other dependencies, no
network calls after load.

## Layout of the code

- `js/geometry.js` - distance parsing, circle intersection, chain solver,
  Gauss-Newton least-squares adjustment, item/segment geometry. Pure
  functions, unit tested.
- `js/state.js` - store: state (v2), undo/redo snapshots, localStorage,
  actions for points/measurements/walls/items/layers, v1 migration.
- `js/plan.js` - orthographic three.js plan view: display-list renderer,
  touch gestures (tap / pan / pinch / item drag), DOM overlay labels,
  scale bar. Knows nothing about the model.
- `js/view3d.js` - extruded 3D perspective view with OrbitControls.
- `js/items.js` - item categories, colours, presets.
- `js/main.js` - controller: modes, placement flows, keypad, hit-testing,
  log sheet, item form, import/export, wiring.

## Bluetooth laser measures

The **laser** header button connects a BLE laser measure via Web
Bluetooth (Chrome on Android/ChromeOS; the page must be served over
HTTPS - the GitHub Pages URL, or localhost). Each reading fills the
active input field as metres, ready for OK - never committed unseen.
Known profiles: Leica DISTO (documented float32 characteristic), Bosch
GLM/PLR service, and generic UART meters (FFE0 / Nordic UART) via a
heuristic decoder (ASCII, float32 metres, uint32 millimetres, with a
millimetre-resolution gate against false positives). Unrecognised
meters still connect and their raw frames appear in hex in the data
sheet's laser section - capture a few readings and use them to add an
exact decoder for that model. The Bosch UniversalDistance 50C is
supported natively (SIG service 0xFDE8, characteristic 02a6c0d2,
auto-sync enabled on connect; confirmed against a real device).

### Auto survey mode

With a laser connected, an **auto** toggle appears beside the reference
slots (off by default). When on, readings drive the survey without
touching the screen: in anchor state the first reading measures the
first wall; thereafter each reading pair from the two selected
references places a point - first reading fills "to ref 1", second
fills "to ref 2" and commits, auto-chaining the point into the wall run
until the room is closed. The measuring loop becomes: stand at the
corner, shoot cross A, shoot cross B, walk to the next corner. All
normal guards stay active - implausible pairs are refused (fields kept
for a re-shot), flip corrects a wrong side, the proposed-corner angle
and residuals flag bad readings, and undo/delete recover from anything.
Auto only drives plain point fixing; item placement, wall offsets,
ceiling heights and checks always wait for an explicit OK.

## Deploying

`.github/workflows/pages.yml` deploys the repo root to GitHub Pages on
every push to main. One-time setup: create a GitHub repo, push, then in
the repo Settings -> Pages set Source to "GitHub Actions". The https
Pages URL is also what makes Web Bluetooth available on the phone.

## Roadmap

1. ~~A-B anchor + point fixing by two distances with side disambiguation,
   plan render, localStorage, undo~~ (done)
2. ~~Walls as polylines, closed room outline, least-squares adjustment +
   residual display, measurement log~~ (done)
3. ~~Items with two-distance placement, wall snap, layers current/proposal,
   drag for what-ifs~~ (done)
4. ~~3D extruded view with heights, wall-mounted items, JSON
   export/import~~ (done)
5. ~~GitHub Pages deploy workflow~~ (done - see Deploying)
