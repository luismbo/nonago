# Nonaga — technical notes

How this is built, why it is built that way, and what went wrong along the way. It is meant to be
read by someone who has not seen the code before.

- [What the game is](#what-the-game-is)
- [The stack](#the-stack)
- [Architecture](#architecture)
- [The board is a lattice, not pixels](#the-board-is-a-lattice-not-pixels)
- [The rules engine](#the-rules-engine)
- [Playing a game](#playing-a-game)
- [The computer opponent](#the-computer-opponent)
- [The interface](#the-interface)
- [Publishing](#publishing)
- [Testing](#testing)
- [Bugs worth remembering](#bugs-worth-remembering)
- [Where it could go next](#where-it-could-go-next)

---

## What the game is

Nonaga is a two-player abstract strategy game by Viktor Bautista i Roca. Nineteen wooden discs form
a hexagon; each player has three pawns. You slide a pawn along a straight line until it reaches the
edge of the field or bumps another pawn, then you relocate one disc. You win by getting your three
pawns onto neighbouring discs — a line, a triangle, or a bent tick.

The rulebook is three photographs of a folded leaflet. Everything below was derived from those
photographs, and the diagrams in them were checked against the implementation rather than
remembered.

---

## The stack

Deliberately small. Three dev dependencies, no runtime dependencies at all.

| Tool         | Version | Job                                          |
| ------------ | ------- | -------------------------------------------- |
| TypeScript   | 7.x     | Types, and a type-check gate on every build    |
| Vite         | 8.x     | Dev server, bundler, worker chunking           |
| Vitest       | 5.x     | Tests, sharing Vite's resolution               |

No framework. The interface is ~575 lines of TypeScript manipulating SVG directly, which is a
reasonable size for the amount of state on screen and means there is no reconciler between the game
state and the DOM to reason about.

The whole thing builds to about 35 kB of JavaScript before gzipping — 26 kB of interface and board,
9 kB of search engine — plus 10 kB of CSS. There is nothing to load before the board appears.

Source is ~3,800 lines across twelve files, of which ~1,460 are tests.

---

## Architecture

Four layers, each depending only on the ones below it.

```
  main.ts            clicks -> legal moves; status line, scoreboard, log
  ─────────────────────────────────────────────────────────────────────
  ai/                worker + promise wrapper for the computer
  ─────────────────────────────────────────────────────────────────────
  game/ai.ts         evaluation, negamax search, four difficulty levels
  ─────────────────────────────────────────────────────────────────────
  game/session.ts    undo, move log, draws — what a game *in progress* needs
  ─────────────────────────────────────────────────────────────────────
  game/rules.ts      the rules, as pure functions over an immutable state
  game/hex.ts        hex coordinates; which discs can be slid out
```

The important boundary is `rules.ts`. It has no imports from the DOM, no timers, and no I/O, and
every function takes a state and returns a new one. That is what makes the rules testable in
milliseconds, and it is why the tests can play hundreds of complete games without a browser.

`session.ts` sits on top because undo, the move log and draw detection are not rules — they belong
to a game at a table rather than to the game itself. `ai.ts` sits above that because it needs to
know what a legal turn is, not how one is played.

The interface never implements a rule. It asks the engine what is legal, offers exactly that, and
forwards the answer. When it got that wrong it was a bug in the interface; when the disc-removal
rule was wrong it was a bug in the engine, found by a test.

---

## The board is a lattice, not pixels

The single most consequential decision.

Discs sit on cells of an infinite triangular lattice in axial coordinates, not on arbitrary
positions. Every question the rules ask is then an exact integer question:

- "does a pawn have anywhere to go?" — six lookups
- "will this disc touch two others?" — count occupied neighbours
- "is this disc walled in?" — count occupied neighbours again

Nothing is approximated, nothing drifts with floating-point error, and the board can grow and
shrink without any geometric bookkeeping.

```ts
// src/game/hex.ts
export interface Cell { readonly q: number; readonly r: number }
export type CellKey = string;
export const cellKey = (cell: Cell): CellKey => `${cell.q},${cell.r}`;
```

Cells double as `Map`/`Set` keys through the `CellKey` string. Pointy-top axial coordinates put the
19 starting discs in rows of 3-4-5-4-3, exactly as in the rulebook:

```ts
export const toPixel = (cell: Cell, radius = 1) => ({
  x: Math.sqrt(3) * radius * (cell.q + cell.r / 2),
  y: 1.5 * radius * cell.r,
});
```

`toPixel` exists purely for drawing. No rule reads it.

### The six corners are hardcoded, and that is deliberate

```ts
export const CORNER_CELLS: readonly Cell[] = [
  { q: 0, r: -2 },  // top-left
  { q: 2, r: -2 },  // top-right
  { q: 2, r: 0 },   // right
  { q: 0, r: 2 },   // bottom-right
  { q: -2, r: 2 },  // bottom-left
  { q: -2, r: 0 },  // left
];
```

Ordered clockwise from the top-left, because that is the order the rulebook alternates pawns in:
black, red, black, red, black, red. A test asserts that order, so if the list were ever reordered
the setup would fail loudly rather than producing a subtly different game.

### Which discs can be slid out

The one genuinely hard rule, and the one I got wrong first.

The rulebook says: *"You are only allowed to take away those discs that can be slid out of position
without moving other discs in the process."* My first implementation read that as a neighbour
**count** — a disc with an empty cell beside it is on the rim, so it lifts. That is wrong, and the
geometry shows why.

A disc can only leave along a straight line, and it is blocked by every neighbour within 90° of
that line. What matters is the **angles** between neighbours, not how many there are. Five
neighbours leave only 60° to slide through, so the disc is completely wedged despite a space beside
it. Three neighbours spread 120° apart are also immovable.

Measured across the layouts:

| neighbours      | clearance | can it move? |
| --------------- | --------- | ------------ |
| none            | 180°      | yes          |
| one             | 180°      | yes          |
| two adjacent    | 150°      | yes          |
| two opposite    | 90°       | yes (tangent) |
| three in a row  | 120°      | yes          |
| three spread    | 60°       | **no**       |
| four in a row   | 90°       | yes          |
| four with a gap | 60°       | **no**       |
| five            | 60°       | **no**       |
| all six         | 30°       | **no**       |

Three of those disagreed with the count-based rule. Since neighbours are always lattice directions,
the whole thing reduces to integer arithmetic over the widest gap:

```ts
export function canSlideOut(discs: ReadonlySet<CellKey>, cell: Cell): boolean {
  const occupied: number[] = [];
  DIRECTIONS.forEach((direction, index) => {
    if (discs.has(cellKey(add(cell, direction)))) occupied.push(index);
  });
  if (occupied.length === 0) return true;

  // Widest gap between neighbouring discs, counted in 60° steps.
  let widest = 0;
  for (let i = 0; i < occupied.length; i++) {
    const next = occupied[(i + 1) % occupied.length];
    const gap = i === occupied.length - 1 ? next + 6 - occupied[i] : next - occupied[i];
    widest = Math.max(widest, gap);
  }
  return widest >= 3;   // three 60° steps is a 180° gap
}
```

A gap of exactly 180° counts as clear, which is not an arbitrary rounding. The rulebook's own
example of a legal lift shows a disc with four neighbours and precisely such a gap, marked with a
green tick. And it has to: all six corners of the opening board carry pawns, so if edge discs were
immovable the first turn could not be completed at all. Getting the boundary wrong bricks the game
at move one — which is the kind of thing worth checking rather than reasoning about.

---

## The rules engine

A turn is always two forced steps, so the state has three phases:

```ts
export type Phase = 'move-pawn' | 'move-disc' | 'game-over';

export interface GameState {
  readonly discs: ReadonlySet<CellKey>;    // cells holding a disc
  readonly pawns: ReadonlyMap<CellKey, Player>;
  readonly turn: Player;
  readonly phase: Phase;
  readonly lockedDisc: CellKey | null;    // relocated last turn: off limits
  readonly heldDisc: CellKey | null;      // picked up, not yet placed
  readonly winner: Player | null;
  readonly turnNumber: number;
}
```

Every field is `readonly` and every function returns a new state. Nothing mutates. That is what lets
the search explore millions of positions without any risk of one undoing another, and it is why undo
is a stack of states rather than an inverse operation — there is nothing to invert.

### Sliding a pawn

Straightforward once you notice that discs do not block pawns. A pawn rides *over* them; only the
edge of the field and other pawns stop it.

```ts
export function slidePawn(state: GameState, from: CellKey, direction: Cell): CellKey | null {
  let at = from;
  for (;;) {
    const next = cellKey(add(parseKey(at), direction));
    if (!state.discs.has(next)) break;   // the edge of the field
    if (state.pawns.has(next)) break;    // another pawn is in the way
    at = next;
  }
  return at === from ? null : at;        // null means it cannot move that way at all
}
```

A test asserts that the red pawn on the top-right corner has exactly the three moves shown in the
rulebook's first diagram, at the exact cells in that diagram.

### Relocating a disc

`liftableDiscs` is free discs that are not walled in and not the one the opponent just moved.
`placementCells` is empty cells that will touch at least two remaining discs.

Two judgement calls live here, both places where the physical game leans on players to do the
sensible thing:

**A disc must actually move.** Putting a disc back on the exact spot it was lifted from is not
offered, because the rules relocate it to *another position* — and because allowing it would hand
out free passes, which let random play wander indefinitely.

```ts
  const spots = [...candidates].filter(
    (cell) =>
      !state.discs.has(cell) &&
      cell !== state.heldDisc &&          // <- must be a different position
      touchCount(state.discs, parseKey(cell)) >= 2,
  );
  return spots.length > 0 ? spots : [state.heldDisc];   // but it may always go home
```

**A tip disc may go home.** A disc on the end of the field sometimes has nowhere at all that two
discs would let it rest. Rather than dead-end the turn, it may return to where it came from.

### Winning

The rulebook names three shapes — line, triangle, tick. Those are exactly the three connected
three-vertex subsets of the hex grid, so the check collapses to a count:

```ts
export function isWinningShape(cells: readonly CellKey[]): boolean {
  if (cells.length !== 3) return false;
  const [a, b, c] = cells.map(parseKey);
  const touching = [areAdjacent(a, b), areAdjacent(a, c), areAdjacent(b, c)].filter(Boolean);
  return touching.length >= 2;   // two touching pairs == one connected group of three
}
```

### Settling

A pawn can genuinely be walled in on all six sides — every direction either off the field or
blocked. I found a real example by hunting for stuck positions in random play. `settle` skips the
unusable step:

```ts
export function settle(state: GameState): GameState {
  let next = state;
  for (let step = 0; step < 4; step++) {
    if (next.phase === 'game-over') return next;
    if (next.phase === 'move-pawn') {
      if (legalPawnMoves(next).length > 0) return next;
      next = { ...next, phase: 'move-disc' };        // no pawn can slide; move a disc instead
      continue;
    }
    if (next.heldDisc !== null || liftableDiscs(next).length > 0) return next;
    next = { ...next, phase: 'move-pawn', turn: OPPONENT[next.turn], ... };
  }
  return { ...next, phase: 'game-over', winner: null };   // neither side can move
}
```

The disc step usually digs the pawn back out, which is exactly what that rule is *for* — that is not
a workaround, it is the game working. The four-step bound is a backstop against a 2-cycle of mutual
inability, which would otherwise loop forever.

---

## Playing a game

`Session` wraps a `GameState` with the things that belong to a table rather than to the rules.

**Undo** is a stack of snapshots. Each snapshot records the state, how many log entries existed, the
pawn slid so far this turn, and any draw reason. Undo pops. There is no inverse operation to get
wrong.

```ts
interface Snapshot {
  readonly state: GameState;
  readonly turnPawn: PawnMove | null;   // a turn is 3 steps but 1 log line
  readonly logLength: number;
  readonly drawReason: DrawReason | null;
}
```

The `turnPawn` field exists because of a real bug: the pawn slide and the disc move are separate
commits, but they share one log line. The pawn move was committed first, so by the time the turn
ended nothing remembered it, and the log showed "no move" for a turn that plainly had one.

**Draws.** The physical game has no end rule beyond "someone wins", and I measured that ~13% of
random games cycle forever. A board nobody can close still has to end:

```ts
export const REPETITION_LIMIT = 3;   // same position three times
export const TURN_LIMIT = 150;       // or this many turns
export type DrawReason = 'repetition' | 'turn-limit' | 'blocked';
```

`positionSignature` fingerprints everything that matters, deliberately excluding the turn number —
including it would hide the repetition we are looking for.

**A game must never hand back a position it cannot play from.** Undo restores a snapshot verbatim,
so if that snapshot were one the rules would have skipped past, the game would sit with nothing to
click. `session.test.ts` exists specifically to walk a game backwards and assert every intermediate
position is playable.

---

## The computer opponent

### The evaluation

One observation drives everything: **you win exactly when two of your three pawns are touching.**
So the game is a race to manufacture those two adjacencies while denying the opponent theirs, and
almost every term measures that.

```ts
export function quickScore(state: GameState, me: Player): number {
  const mine = pawnCellsOf(state, me);
  const theirs = pawnCellsOf(state, OPPONENT[me]);
  return (
    ADJACENCY * (adjacencyCount(mine) - adjacencyCount(theirs)) -   // 320
    SPREAD    * (spreadOf(mine) - spreadOf(theirs))        -         //  45
    enclosure(state, mine) - enclosure(state, theirs)
  );
}
```

- **adjacency** (320) — touching pairs already made. The closer to two, the better.
- **spread** (45) — distance still to travel before each pair touches. Being one step away from a
  win is worth far more than being three.
- **enclosure** — open cells around each pawn. A pawn with six discs round it is dead weight and
  scores −55; one with five scores −14; anything else scores positively, because room to manoeuvre
  is also room to be joined. Enclosed pawns are how games are lost.
- **threat** (±5000) — whether a single slide would win outright. Dominates everything else, and is
  checked first in move ordering so alpha-beta finds wins immediately.

The full `evaluate` adds threats and a repetition penalty on top of `quickScore`. A slide can add
at most one new adjacency, so a player with no adjacent pair cannot win on the spot — worth knowing,
because that is the most expensive thing to evaluate and is skipped most of the time.

### The search

Negamax with alpha-beta over whole turns, since a turn is always the same two forced steps.
Iterative deepening: each pass searches one turn deeper and keeps the last pass that finished, so
running out of time costs depth rather than the move.

Move ordering is what makes alpha-beta worth having. It only ever explores the first move in full,
so ordering decides how much of the tree gets skipped:

```ts
function orderPlans(plans, me) {
  return plans
    .map((plan) => ({
      plan,
      value: plan.next.winner === me ? 1e9 : quickScore(plan.next, me),
    }))
    .sort((a, b) => byDescending(a.value, b.value))
    .map((entry) => entry.plan);
}
```

### Getting the tree small enough to walk

This was the hard part. A turn is the cross product of pawn slides and disc relocations — **570
combinations in the opening** — and the first working version spent **200 seconds** on a single
move.

Three fixes, in order of impact:

**1. Filter on geometry before building anything.** A disc only matters if it lands touching a pawn:
it can open a pawn's way out, or block a path, and nothing else. So placements away from every pawn
are dropped outright.

**2. Rank survivors before constructing a state.** This is the part that actually mattered. Building
a position means two fresh collections and a turn counter, and it was by far the most expensive thing
in the search. Ranking the candidates by distance to the nearest pawn is pure arithmetic:

```ts
const nearPawn = (cell: Cell): number =>
  pawnCells.reduce((best, pawn) => Math.min(best, hexDistance(cell, pawn)), 99);
```

Cheap geometry first, expensive construction only for the handful of moves actually intended to be
looked at. Generating one node's moves fell from ~53 ms to ~14 ms, and that is what turned a search
that could not finish into one that fits inside its budget.

**3. Shortlist across source discs.** The top few candidates are taken round-robin from different
source discs, so the shortlist holds genuinely different ideas rather than five variations on one
move.

Measured on the opening position, 72 plans per node at the default width:

| level  | depth reached | nodes | time    | budget |
| ------ | ------------- | ----- | -------- | ------ |
| Casual | 1 of 1        | 36    | 10 ms    | 350 ms |
| Club   | 2 of 2        | 203   | 469 ms   | 900 ms |
| Expert | 2 of 3        | 745   | 2009 ms  | 2000 ms |
| Master | 2 of 5        | 1234  | 3505 ms  | 3500 ms |

Expert and Master want more depth than their budget buys. That is the budget working, and it is why
the levels are separated by error rate as much as by depth.

### The time budget is load-bearing

The first version had a bug that would have frozen the page. The node counter was part of a context
object spread down the tree at each ply, so the count the time check sampled reset every ply and the
limit never fired:

```
budget=50ms  -> took 1696ms
budget=150ms -> took 1707ms
```

The budget is now one mutable object shared by every ply, checked on every node — a node costs
milliseconds, so reading the clock is free next to it:

```ts
interface Budget {
  readonly deadline: number;
  nodes: number;          // shared, not copied
}
const checkBudget = (ctx: Context): void => {
  if (now() > ctx.budget.deadline) throw new Aborted();
};
```

Verified — the budget is honoured to within the cost of the last node:

| budget | returned in | depth reached |
| ------ | ----------- | ------------- |
| 20 ms  | 58 ms       | 0             |
| 60 ms  | 70 ms       | 1             |
| 200 ms | 212 ms      | 1             |
| 600 ms | 607 ms      | 1             |

### Difficulty is mostly about error

Four levels, differing in depth and — more importantly — in how often they are wrong. No player is
perfect, and a beginner has to be able to win:

| id       | depth | budget  | disc candidates | random move | pick from top |
| -------- | ----- | ------- | --------------- | ----------- | ------------- |
| casual   | 1     | 350 ms  | 4               | 40%         | 4             |
| club     | 2     | 900 ms  | 6               | 15%         | 3             |
| expert   | 3     | 2000 ms | 8               | 4%          | 2             |
| master   | 5     | 3500 ms | 10              | 0%          | 1             |

```ts
export function chooseTurn(result, difficulty, random = Math.random) {
  if (random() < difficulty.randomMoveChance) return pick(result.scored, random).plan;
  const pool = result.scored.slice(0, Math.max(1, difficulty.pickFromTop));
  return pick(pool, random).plan;
}
```

`randomMoveChance` sometimes ignores the search entirely; `pickFromTop` chooses between near-equal
moves so the computer does not become predictable or exploitable by repetition. Both are seeded from
an injectable `random`, which is what lets the tests play 25 different games per level deterministically.

### Why it runs in a worker

A node costs milliseconds. On the main thread that is long enough for the board to stutter and for
clicks to be dropped. `ai/worker.ts` is stateless — the interface posts a position, gets back the
turn to play and how the search went. It runs one shallow search at start-up so the first real move is
not the slow one.

`ai/opponent.ts` wraps it in promises, keeps one request in flight, and falls back to searching on
the main thread if workers are unavailable. A hung worker is detected by a timer several seconds past
the level's own budget, terminated, and replaced.

### Plans are suggestions, not instructions

The plan comes back for a position that may have moved on — an undo, or a new game. So the interface
re-checks **every step** against the live rules rather than trusting it, and a `generation` counter
invalidates any search that arrives after the game changed underneath it.

```ts
if (lift && place && this.session.state.phase !== 'game-over') {
  if (liftableDiscs(this.session.state).includes(lift)) {   // re-check, do not trust
    ...
  }
}
```

---

## The interface

One SVG, reconciled in place rather than redrawn.

```ts
private syncPawns(state: GameState, model: BoardModel): void {
  // Reuse the sliding pawn's element so the CSS transition carries it over.
  if (model.slide) {
    const node = this.pawns.get(model.slide.from);
    if (node) {
      this.pawns.delete(model.slide.from);
      this.pawns.set(model.slide.to, node);
    }
  }
  ...
}
```

Pawns and discs are keyed by cell in `Map`s and re-keyed rather than recreated, so moving a pawn is a
`transform` change on an existing element and the CSS transition animates it for free. Recreating the
element would snap instead of slide.

The `viewBox` is recomputed from the discs on every render, because the field grows and shrinks as
discs move, and the board should stay framed without anyone thinking about it.

### Two clicks, not one

The first version played a move the moment you clicked a pawn. That is wrong: you need to see where
it can go first. Clicking a pawn selects it and shows its slides as dashed arrows; clicking a
highlighted landing spot plays the move. Escape deselects.

Arrows stop short of their target so the arrowhead sits on the marker rather than under it. Landing
spots are ghosted wooden discs, hover highlighted.

### A note on classes

```ts
node.classList.toggle('is-winner', model.state.winner === owner);
```

Toggling rather than adding and removing. Pawn elements are reused between games, so a leftover
`is-winner` from a finished game — pawns still glowing as the winner of the last one — would
otherwise stick around. The fuzz harness caught this.

---

## Publishing

Static site, no server. Push to `main` and GitHub Actions publishes it.

```yaml
- run: npm ci
- run: npm run typecheck     # gates the build
- run: npm test              # gates the build
- run: npm run build
- uses: actions/configure-pages@v5
- uses: actions/upload-pages-artifact@v3
    with: { path: dist }
```

Deploy and PR jobs are separate, with `id-token: write` and `pages: write` scoped to what each needs.
`concurrency` cancels a superseded deploy rather than racing it.

The build sets `base: './'`, so all asset paths are relative and the same `dist/` works at
`https://user.github.io/` **and** `https://user.github.io/repo/`. Without that, a project site would
404 on every asset.

One-time setup: **Settings → Pages → Source → GitHub Actions**.

---

## Testing

97 tests, no mocks and no browser for the rules or the AI.

| file              | tests | what it covers                                  |
| ----------------- | ----- | ----------------------------------------------- |
| `rules.test.ts`   | 62    | setup, sliding, winning, disc rules, whole turns |
| `ai.test.ts`      | 28    | evaluation, turn generation, search, difficulty  |
| `session.test.ts` | 7     | undo, and that no position is ever unplayable    |

The ones that earned their keep:

- **The rulebook diagram as a test.** The red corner pawn must have exactly three moves, at exactly
  the three cells in the rulebook's first diagram.
- **Every offered disc is slidable.** `liftableDiscs` is checked against `canSlideOut` over the
  whole board, which is what caught the neighbour-count bug.
- **A full random self-play game**, asserting it reaches a finish, the board stays at 19 discs with
  every pawn still standing, and every log line corresponds to a real turn.
- **The time budget**, across 20/60/200/600 ms, asserting the search returns within a small
  multiple of what it was given — the test that would have caught the frozen page.
- **Every level plays only legal turns**, 12 seeds each.
- **Unwinding never returns a dead position.**
- **The strongest level beats the weakest** over several games — a guard against a search that is not
  actually looking at the position.

Two notes on practice. AI tests run real searches and take seconds, so `testTimeout` is raised to
120 s in `vite.config.ts` rather than weakening the tests. And several fixtures were not guessed: a
scratch test enumerated the board to find genuine one-slide-win and walled-in positions, because
hand-written positions kept being wrong in ways that made the tests pass for the wrong reason.

The interface was verified by driving a real Chromium through Playwright — playing games, switching
levels, and a fuzz pass of ~400 random actions with undo and new-game thrown in, watching for stalls.
That is where the click-to-play bug, the undo deadlock and the stale `is-winner` came from. None of
them were visible from unit tests.

---

## Bugs worth remembering

Roughly in order of how much they would have hurt.

**The disc-removal rule was a neighbour count.** Counted neighbours instead of measuring angles, so
a disc with five neighbours — jammed solid, 60° of clearance — was offered as liftable. Found by
re-reading the rulebook text against the diagrams and checking the geometry.

**The search time limit never fired.** The node counter was copied down the tree per ply, so the
sample the clock check read reset every ply. A 50 ms budget ran 1.7 s. In a browser: a frozen page.
Found by printing `nodes` in a profiling run and seeing `0`.

**The first search took 200 seconds per move.** Fixed by ranking candidates geometrically before
constructing game states.

**Undo onto the computer's turn froze the game.** A turn is three steps; a half-finished one belongs
to whoever is at the board, and against a computer there is nobody there. Undo now rewinds a whole
round against the computer.

**Clicking a pawn played the move immediately** instead of letting you choose a direction. Found by
playing the built site.

**The move log lost the pawn move.** A turn is three commits but one log line, and the pawn slide
was committed first, so nothing remembered it. The log said "no move" for turns that plainly had one.

**The thinking banner cleared too early** — when the plan arrived rather than when the move was
played, leaving pawns and a disc sliding with nothing on screen to say why.

**A walled-in player was a genuine stuck state.** Found by hunting for one in random play, not by
reasoning. `settle` handles it, and the disc step usually digs the pawn out.

**~13% of random games never ended.** Measured before adding any cap.

**A stale `is-winner` survived into the next game**, because the class was only ever added.

The pattern worth taking from that list: every one was found by *measuring* something — printing a
counter, timing a search, driving the built page, enumerating positions — rather than by reading the
code and feeling satisfied. The two that looked most like "correct code" (the neighbour count, the
time budget) were the two worst.

---

## Where it could go next

- **Opening book.** A real database of positions and their values would make Master substantially
  stronger than search alone, and is the standard next step for a game this size.
- **Move ordering by TT.** Alpha-beta wants move ordering; a transposition table would improve it and
  also cut repeated work across iterative deepening passes.
- **WebGPU or WASM.** Unnecessary at four levels, but the same search would go several times deeper.
- **Difficulty by time rather than depth**, for machines that vary in speed. Depth is honest about
  what the computer did; time is fairer across hardware.
- **Online play** would need the session to serialise, which the immutable state is already shaped
  for.
