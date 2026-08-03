# house measurer

Browser-based room measurement and layout tool for surveying an old stone
building with a cheap laser distance measurer. Points are fixed by
trilateration - two distances from two already-fixed points - so rooms with
no right angles, alcoves and chimney breasts come out true. Entirely
client-side, state in localStorage, no build step.

## Measuring

1. Mark two anchor points A and B on the walls with tape crosses. Measure
   A to B, type it in, press OK. The tool renders the baseline immediately.
2. For each new point: tap two already-fixed points on the plan, type the
   measured distance to each, press OK (OK on the first field jumps to the
   second). Both candidate positions are shown while you type - OK places
   the marked one, tapping the other candidate places that one instead, and
   the flip key swaps the last point afterwards.
3. Any fixed point can serve as a reference for later points, so the mesh
   grows across the room. The reference pair is kept after each commit, so
   fixing several points from the same pair needs no extra taps.
4. Redundancy: select two existing points, type the measured distance,
   press **record**. All positions are least-squares adjusted over every
   measurement; residuals show per point on the plan and per measurement in
   the log (green < 1 cm, amber < 3 cm, red beyond). Nothing is silently
   discarded - every measurement can be edited or deleted in the log and
   the solution recomputes live.

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
- The **log** sheet also exports/imports the full state as JSON (download,
  copy to clipboard, paste or file) for backup and moving between devices.

Every commit is undoable (undo history survives reloads) and everything
autosaves to localStorage on every change. "clear everything" lives behind
the ? help panel and needs a second confirming tap.

## Running / developing

Static files, native ES modules, no build. Serve the directory over HTTP
(module imports do not work from file://):

    python3 -m http.server 8017
    # open http://localhost:8017

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

## Deploying

It is a plain static directory - GitHub Pages serving the repo root from
`main` works as-is (Settings -> Pages -> Deploy from branch). A proper
workflow file is milestone 5.

## Roadmap

1. ~~A-B anchor + point fixing by two distances with side disambiguation,
   plan render, localStorage, undo~~ (done)
2. ~~Walls as polylines, closed room outline, least-squares adjustment +
   residual display, measurement log~~ (done)
3. ~~Items with two-distance placement, wall snap, layers current/proposal,
   drag for what-ifs~~ (done)
4. ~~3D extruded view with heights, wall-mounted items, JSON
   export/import~~ (done)
5. GitHub Pages deploy workflow
