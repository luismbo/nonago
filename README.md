# Nonaga

A browser version of [Nonaga](https://boardgamegeek.com/boardgame/233130/nonaga), the abstract
strategy game for two players by **Viktor Bautista i Roca** (graphics by Ajsa Zdravkovic).

Nineteen wooden discs in a hexagon, six pawns, and one goal: be the first to gather your three
pawns on neighbouring discs — in a line, a triangle, or a tick.

It is a static site, so there is nothing to host. Push to `main` and GitHub Actions publishes it.

## Playing

```sh
npm install
npm run dev        # http://localhost:5173
```

Two players share one screen. Whoever opens is picked at random, as the rules ask. Click one of
your pawns to see where it can slide, click a landing spot, then lift a disc off the rim and put it
back where it touches two others. `Escape` takes back a step, and so does **Undo**.

| Command            | What it does                                  |
| ------------------ | --------------------------------------------- |
| `npm run dev`      | Development server with hot reload            |
| `npm test`         | Rules tests (Vitest)                          |
| `npm run typecheck`| `tsc --noEmit`                                |
| `npm run build`    | Type-check and build to `dist/`               |
| `npm run preview`  | Serve the built `dist/` locally               |

## Publishing to GitHub Pages

The workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) type-checks, tests
and builds on every push to `main`, then deploys `dist/` to Pages.

One-time setup, after pushing the repository to GitHub:

1. **Settings → Pages → Build and deployment → Source → _GitHub Actions_**.
2. Push to `main` (or run the *Deploy to GitHub Pages* workflow by hand from the Actions tab).

The build uses a relative asset base (`base: './'` in `vite.config.ts`), so the same output works
both at `https://<user>.github.io/` and at `https://<user>.github.io/<repo>/`.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the same checks on pull requests.

## How it is put together

```
src/
  game/
    hex.ts        Axial hex coordinates: the 19-cell board and the six corners
    rules.ts      The rules, as pure functions over an immutable state
    session.ts    A game in progress: undo, move log, draws
    rules.test.ts Tests for all of the above
  ui/
    board.ts      The SVG board, reconciled in place so pawns can animate
  main.ts         Clicks -> legal moves, plus the status line, scoreboard and log
```

Nothing about the board is simulated in pixels. Discs sit on cells of an infinite triangular
lattice in axial coordinates, so "slides to the edge", "touches at least two discs" and "is walled
in by six neighbours" are all exact integer questions. That keeps the rules honest and testable,
and it is why `rules.ts` never touches the DOM.

Two deliberate decisions worth knowing about, both places where the physical game relies on players
to do the sensible thing:

- **A disc must be relocated, not replaced.** Putting a disc back on the exact spot it was lifted
  from is not offered — the rules say the disc is moved *to another position*, and allowing it
  would hand out free passes. The one exception is a disc on the tip of the field, which may have
  nowhere else to rest; it is allowed to go home so the turn can finish.
- **Games always end.** The physical game has no end rule beyond "someone wins", and a game can be
  wandered in circles forever. Here a game is drawn after the same position comes round three times
  or after 150 turns, both far outside anything a real game reaches.

## Rules

The board is a hexagon of 19 discs; red and black pawns alternate around its six corners.

A turn is two steps:

1. **Slide a pawn** in a straight line. It travels as far as it can — stopping on the last disc
   before the edge of the field, or just before another pawn. Discs do not block it; it rides over
   them.
2. **Move a disc.** Take a free disc (no pawn on it) from the rim of the field — one with an empty
   space beside it, so that it can be slid out without moving the others — and put it somewhere it
   touches at least two other discs. The disc your opponent relocated last turn is off limits to
   you. Removing a disc may leave another disc touching the rest on one side only; that is allowed.

You win by getting all three of your pawns onto neighbouring discs: a straight line, a triangle, or
a bent tick.

## Credits

Nonaga was designed by Viktor Bautista i Roca, with graphic design by Ajsa Zdravkovic. This is an
unofficial digital version, built from the rulebook.
