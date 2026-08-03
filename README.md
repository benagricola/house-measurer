# house measurer

Browser-based room measurement tool for surveying an old stone building with a
cheap laser distance measurer. Points are fixed by trilateration - two
distances from two already-fixed points - so rooms with no right angles,
alcoves and chimney breasts come out true. Entirely client-side, state in
localStorage, no build step.

## Using it

1. Mark two anchor points A and B on the walls with tape crosses. Measure
   A to B, type it in, press OK. The tool renders the baseline immediately.
2. For each new point: tap two already-fixed points on the plan, type the
   measured distance to each, press OK (OK on the first field jumps to the
   second). Both candidate positions are shown while you type - OK places
   the marked one, tapping the other candidate places that one instead, and
   the flip key swaps the last point afterwards.
3. Any fixed point can serve as a reference for later points, so the mesh
   grows across the room. The two reference slots are kept after each commit,
   so fixing several points from the same pair needs no extra taps.

Units: a number **with** a decimal point is metres, **without** is
centimetres. `342` = 3.42 m, `3.42` = 3.42 m, `84` = 84 cm. For a whole
number of metres add a trailing dot: `15.` = 15 m. Comma works as a decimal
separator. The interpreted value is always shown under the field before you
commit.

Gestures: drag to pan, pinch (or scroll wheel) to zoom, tap a point to
select/deselect it as a reference. On a keyboard: digits, Enter = OK,
Tab = other field, `f` = flip, ctrl+z / ctrl+y = undo / redo.

Every commit is undoable and everything autosaves to localStorage on every
change (undo history included, so it survives reloads). "clear everything"
lives behind the ? help panel and needs a second confirming tap.

If two typed distances cannot meet (laser noise, typo), the shortfall is
shown in cm and the point is refused; shortfalls under 3 cm are placed on
the line between the references and reported in the residual pill in the
header (green < 1 cm, amber < 3 cm, red beyond).

## Running / developing

Static files, native ES modules, no build. Serve the directory over HTTP
(module imports do not work from file://):

    python3 -m http.server 8017
    # open http://localhost:8017

Tests (pure geometry + store, no browser needed):

    node --test test/geometry.test.mjs

three.js is vendored and pinned in `vendor/three.module.min.js`
(v0.164.1, MIT - see `vendor/three.LICENSE`). No other dependencies, no
network calls after load.

## Layout of the code

- `js/geometry.js` - distance parsing, circle intersection, chain solver.
  Pure functions, unit tested. The least-squares adjustment (milestone 2)
  slots in here.
- `js/state.js` - store: state, undo/redo snapshots, localStorage.
- `js/plan.js` - orthographic three.js plan view, touch gestures, DOM
  overlay for labels, scale bar. Gets handed a display list; knows nothing
  about the model.
- `js/main.js` - controller: input flow, keypad, hit-testing, wiring.

## Deploying

It is a plain static directory - GitHub Pages serving the repo root from
`main` works as-is (Settings -> Pages -> Deploy from branch). A proper
workflow file is milestone 5.

## Roadmap

1. ~~A-B anchor + point fixing by two distances with side disambiguation,
   plan render, localStorage, undo~~ (done)
2. Walls as polylines, closed room outline, least-squares adjustment +
   residual display, measurement log panel
3. Items with two-distance placement, wall-parallel snap, layers
   current/proposal, drag for what-ifs
4. 3D extruded view with heights, wall-mounted items, JSON export/import
5. GitHub Pages deploy workflow
