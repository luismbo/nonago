/**
 * A computer opponent.
 *
 * A turn is a forced two-step sequence — slide a pawn, then relocate a disc — so
 * a "turn" is the natural unit of search. Negamax with alpha-beta walks whole
 * turns; the ordering of moves and the evaluation are what make it strong.
 *
 * The evaluation is built around one observation: a player wins exactly when two
 * of their three pawns are adjacent to each other, so the game is really a race
 * to manufacture those two adjacencies while denying the opponent theirs. Almost
 * every term below is a measure of how close a player is to that, or of how hard
 * it is for the opponent to get there.
 */

import {
  type Cell,
  type CellKey,
  canSlideOut,
  cellKey,
  hexDistance,
  neighbours,
  parseKey,
} from './hex';
import {
  type DiscMove,
  type GameState,
  type PawnMove,
  type Player,
  OPPONENT,
  isWinningShape,
  legalPawnMoves,
  liftDisc,
  liftableDiscs,
  movePawn,
  placeDisc,
  placementCells,
  positionSignature,
  settle,
} from './rules';

// ---------------------------------------------------------------------------
// Plans: the legal turns of a position
// ---------------------------------------------------------------------------

/**
 * One whole turn, as the three steps the interface has to perform in order.
 * `lift` and `place` are null when the rules make that step unnecessary, which
 * happens when a player is so walled in that it has to skip straight past the
 * pawn slide.
 */
export interface TurnPlan {
  readonly pawn: PawnMove | null;
  readonly lift: CellKey | null;
  readonly place: CellKey | null;
  readonly next: GameState;
}

const pushDiscPlans = (
  plans: TurnPlan[],
  afterPawn: GameState,
  pawn: PawnMove | null,
  cap = Number.POSITIVE_INFINITY,
): void => {
  const liftable = liftableDiscs(afterPawn);
  if (liftable.length === 0) {
    // No disc can be taken, so the turn passes straight over.
    plans.push({ pawn, lift: null, place: null, next: settle(afterPawn) });
    return;
  }

  if (cap === Number.POSITIVE_INFINITY) {
    for (const from of liftable) {
      const held = liftDisc(afterPawn, from);
      for (const to of placementCells(held)) {
        plans.push({ pawn, lift: from, place: to, next: placeDisc(held, to) });
      }
    }
    return;
  }

  // Choosing the shortlist before building any positions is the point of this
  // function. Each candidate ends in a whole new game state — two fresh
  // collections and a turn counter — and that is by far the most expensive thing
  // in the search, so a cheap geometric filter first means we pay it only for the
  // handful of moves we actually intend to look at.
  //
  // A disc only matters if it touches a pawn: it opens a way out, or blocks a
  // path, and nothing else. Ranking by how close it sits to the pawns both keeps
  // the useful moves and drops most of the rest for free.
  const pawnCells = [...afterPawn.pawns.keys()].map(parseKey);
  const nearPawn = (cell: Cell): number =>
    pawnCells.reduce((best, pawn) => Math.min(best, hexDistance(cell, pawn)), 99);

  interface Candidate {
    readonly from: CellKey;
    readonly to: CellKey;
    readonly proximity: number;
  }
  const candidates: Candidate[] = [];
  for (const from of liftable) {
    const held = liftDisc(afterPawn, from);
    for (const to of placementCells(held)) {
      const cell = parseKey(to);
      candidates.push({ from, to, proximity: nearPawn(cell) });
    }
  }
  if (candidates.length === 0) return;

  candidates.sort((a, b) => a.proximity - b.proximity);

  // Take the closest few, spread across different source discs so the shortlist
  // holds genuinely different ideas rather than several variations on one move.
  const perSource = new Map<CellKey, Candidate[]>();
  for (const candidate of candidates) {
    perSource.set(candidate.from, [...(perSource.get(candidate.from) ?? []), candidate]);
  }
  const chosen: Candidate[] = [];
  for (let round = 0; chosen.length < cap; round++) {
    let added = false;
    for (const bucket of perSource.values()) {
      const candidate = bucket[round];
      if (!candidate) continue;
      chosen.push(candidate);
      added = true;
      if (chosen.length === cap) break;
    }
    if (!added) break;
  }

  const me = afterPawn.turn;
  const built = chosen.map((candidate) => {
    const held = liftDisc(afterPawn, candidate.from);
    return { plan: { pawn, lift: candidate.from, place: candidate.to, next: placeDisc(held, candidate.to) }, proximity: candidate.proximity };
  });

  if (built.length === 1) {
    plans.push(built[0].plan);
    return;
  }

  // Now that the survivors are few, judge them properly.
  plans.push(
    ...built
      .map((entry) => ({ plan: entry.plan, value: quickScore(entry.plan.next, me) }))
      .sort((a, b) => byDescending(a.value, b.value))
      .map((entry) => entry.plan),
  );
};

/**
 * The turns available to the player on move.
 *
 * `width` is how many disc relocations to shortlist. Pass `Infinity` for the
 * complete, unpruned set of every legal combination — that is what the tests and
 * the interface use, since a human player must be offered every legal choice. The
 * search passes a small number instead, and gets a tree it can actually walk.
 */
export function legalTurns(
  state: GameState,
  width: number = DISC_CANDIDATES,
): TurnPlan[] {
  if (state.phase !== 'move-pawn') return [];
  const plans: TurnPlan[] = [];

  const pawnMoves = legalPawnMoves(state);
  if (pawnMoves.length === 0) {
    // Walled in on all six sides: settle skips to the disc step.
    pushDiscPlans(plans, settle(state), null, width);
    return plans;
  }

  if (width === Number.POSITIVE_INFINITY) {
    for (const pawn of pawnMoves) {
      const afterPawn = movePawn(state, pawn);
      if (afterPawn.phase === 'game-over') {
        plans.push({ pawn, lift: null, place: null, next: afterPawn });
        continue;
      }
      pushDiscPlans(plans, afterPawn, pawn, Number.POSITIVE_INFINITY);
    }
    return plans;
  }

  // The narrowed set: every legal pawn slide, paired with the best few disc
  // relocations available after that slide. Ranking them here costs one eval per
  // candidate rather than one per pawn-and-disc combination.
  for (const pawn of pawnMoves) {
    const afterPawn = movePawn(state, pawn);
    if (afterPawn.phase === 'game-over') {
      plans.push({ pawn, lift: null, place: null, next: afterPawn });
      continue;
    }
    pushDiscPlans(plans, afterPawn, pawn, width);
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Beyond this a result is decided rather than merely likely. */
const MATE = 1_000_000;

/** Winning is worth far more than any structural advantage. */
const THREAT = 5_000;
/** Two pawns already touching, per pair. */
const ADJACENCY = 320;
/** A step closer to touching, per pawn pair. */
const SPREAD = 45;
/**
 * Default disc relocations to shortlist at each node.
 *
 * A turn is the cross product of pawn slides and disc relocations — around 570
 * combinations in the opening, which no search can afford. Ranking the
 * relocations separately and keeping the best few is what brings a node down to
 * `pawn moves x this number`, which is small enough to search properly.
 */
const DISC_CANDIDATES = 8;

/** Give up once the clock is out. Checked on every 256th node. */
/** Going over a position we have already been in loses the game. */
const REPEAT = 400;

/**
 * The three cells holding `player`'s pawns.
 *
 * Memoised on the state object, because the search evaluates the same positions
 * repeatedly — once per node at every depth of the iterative deepening, and once
 * per candidate when ranking disc moves. States are immutable, so a WeakMap is
 * both safe and self-cleaning.
 */
const cellsCache = new WeakMap<GameState, Map<Player, Cell[]>>();

export function pawnCellsOf(state: GameState, player: Player): Cell[] {
  let byPlayer = cellsCache.get(state);
  if (!byPlayer) {
    byPlayer = new Map();
    cellsCache.set(state, byPlayer);
  }
  const cached = byPlayer.get(player);
  if (cached) return cached;

  const cells: Cell[] = [];
  for (const [key, owner] of state.pawns) {
    if (owner === player) cells.push(parseKey(key));
  }
  byPlayer.set(player, cells);
  return cells;
}

/** How many of the three pairs of pawns are touching, from 0 to 3. */
export function adjacencyCount(cells: readonly Cell[]): number {
  if (cells.length !== 3) return 0;
  let touching = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      if (hexDistance(cells[i], cells[j]) === 1) touching++;
    }
  }
  return touching;
}

/** Total distance to having all three pairs touching; 0 once they are. */
export function spreadOf(cells: readonly Cell[]): number {
  if (cells.length !== 3) return 0;
  let total = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      total += Math.max(0, hexDistance(cells[i], cells[j]) - 1);
    }
  }
  return total;
}

/**
 * How enclosed a player's pawns are.
 *
 * A pawn with free cells round it can be moved and can be joined up by others; a
 * pawn boxed in by discs cannot move at all, and one with a single way out is
 * almost as bad. Open cells are also where discs can be slipped underneath, which
 * is how a pawn gets un-stuck, so the count matters twice over.
 */
function enclosure(state: GameState, cells: readonly Cell[]): number {
  let score = 0;
  for (const cell of cells) {
    const closed = neighbours(cell).filter((n) => state.discs.has(cellKey(n))).length;
    if (closed === 6) score -= 55; // ringed in, can never move again
    else if (closed === 5) score -= 14; // one way out, and the opponent can block it
    else score += closed; // room to manoeuvre, and room to be joined
  }
  return score;
}

/**
 * Whether a single pawn slide would connect all three. A slide can add at most
 * one new adjacency, so a player with no adjacent pair cannot win on the spot —
 * worth knowing, because this is the most expensive thing we evaluate.
 *
 * Memoised for the same reason as `pawnCellsOf`.
 */
const winsCache = new WeakMap<GameState, Map<Player, boolean>>();

export function winsOnNextSlide(state: GameState, player: Player): boolean {
  let byPlayer = winsCache.get(state);
  if (!byPlayer) {
    byPlayer = new Map();
    winsCache.set(state, byPlayer);
  }
  const cached = byPlayer.get(player);
  if (cached !== undefined) return cached;

  const mine = pawnCellsOf(state, player);
  let wins = false;
  if (adjacencyCount(mine) >= 1) {
    for (const move of legalPawnMoves(state)) {
      if (state.pawns.get(move.from) !== player) continue;
      const cells = mine.map((cell) => (cellKey(cell) === move.from ? parseKey(move.to) : cell));
      if (isWinningShape(cells.map(cellKey))) {
        wins = true;
        break;
      }
    }
  }
  byPlayer.set(player, wins);
  return wins;
}

/**
 * Cheap structural score: how close each player is to two touching pairs, how
 * much room their pawns have, and how open the field is for discs. Used to order
 * moves, where a full evaluation would cost too much.
 */
export function quickScore(state: GameState, me: Player): number {
  const mine = pawnCellsOf(state, me);
  const theirs = pawnCellsOf(state, OPPONENT[me]);
  return (
    ADJACENCY * (adjacencyCount(mine) - adjacencyCount(theirs)) -
    SPREAD * (spreadOf(mine) - spreadOf(theirs)) +
    enclosure(state, mine) -
    enclosure(state, theirs)
  );
}

export interface EvaluateOptions {
  /** Positions already seen this game, so the search can refuse to loop. */
  readonly recent?: ReadonlySet<string>;
}

/** The position's worth to `me`, from the computer's point of view. */
export function evaluate(state: GameState, me: Player, options: EvaluateOptions = {}): number {
  if (state.phase === 'game-over') {
    if (state.winner === me) return MATE;
    if (state.winner === OPPONENT[me]) return -MATE;
    return 0;
  }

  let score = quickScore(state, me);

  // The immediate threats, which dominate everything else.
  if (winsOnNextSlide(state, me)) score += THREAT;
  if (winsOnNextSlide(state, OPPONENT[me])) score -= THREAT;

  // A position we have been in before is a step closer to a drawn game.
  if (options.recent?.has(positionSignature(state))) score -= REPEAT;

  return score;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchOptions extends EvaluateOptions {
  /** Turns of lookahead to attempt. */
  readonly maxDepth: number;
  /** Wall-clock budget; the search returns the best found so far. */
  readonly timeLimitMs: number;
  /**
   * How many disc relocations to shortlist for the search. This is the main
   * lever on strength against speed: each extra candidate multiplies the width of
   * every node in the tree.
   */
  readonly discChoices: number;
}

/** Exposed for profiling only. */
export const orderPlansForBench = orderPlans;

export interface ScoredTurn {
  readonly plan: TurnPlan;
  readonly score: number;
}

export interface SearchResult {
  readonly scored: readonly ScoredTurn[];
  readonly depth: number;
  readonly nodes: number;
  readonly timeMs: number;
  readonly forced: boolean;
}

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

class Aborted extends Error {}

const byDescending = (a: number, b: number) => b - a;

/**
 * Order a node's plans so alpha-beta finds a good move early and can cut.
 *
 * Moves that win immediately come first, then those that leave the mover's pawns
 * in the best shape. Alpha-beta only ever explores the first move in full, so the
 * ordering decides how much of the tree gets skipped.
 */
function orderPlans(plans: readonly TurnPlan[], me: Player): TurnPlan[] {
  return plans
    .map((plan) => ({
      plan,
      // A win on this move is worth any amount of positional sense.
      value: plan.next.winner === me ? 1e9 : quickScore(plan.next, me),
    }))
    .sort((a, b) => byDescending(a.value, b.value))
    .map((entry) => entry.plan);
}

/**
 * The search budget, held in one mutable object shared by every ply. It has to
 * be shared rather than copied down the tree, or the node count that the time
 * check samples would reset at each ply and the time limit would never fire.
 */
interface Budget {
  readonly deadline: number;
  nodes: number;
}

interface Context {
  readonly options: SearchOptions;
  /** Whose point of view we are scoring from; alternates with depth. */
  readonly me: Player;
  readonly budget: Budget;
  /** Deepest ply reached, for the report back to the interface. */
  readonly maxDepth: number;
}

/**
 * Give up once the clock is out.
 *
 * This is checked on every node, not sampled: a node here is expensive enough
 * that even a handful of extra ones can overshoot a short budget several times
 * over, and reading the clock costs microseconds next to that.
 */
const checkBudget = (ctx: Context): void => {
  if (now() > ctx.budget.deadline) throw new Aborted();
};


function negamax(state: GameState, depth: number, alpha: number, beta: number, ctx: Context): number {
  ctx.budget.nodes++;
  checkBudget(ctx);

  if (state.phase === 'game-over') {
    if (state.winner === ctx.me) return MATE - depth;
    if (state.winner === OPPONENT[ctx.me]) return -(MATE - depth);
    return 0;
  }
  if (depth <= 0) return evaluate(state, ctx.me, ctx.options);

  const plans = orderPlans(legalTurns(state, ctx.options.discChoices), ctx.me);
  if (plans.length === 0) return 0;

  const child: Context = { ...ctx, me: OPPONENT[ctx.me] };
  let best = -Infinity;
  for (const plan of plans) {
    const score = -negamax(plan.next, depth - 1, -beta, -alpha, child);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

/**
 * Score every legal turn of `state`, from `state.turn`'s point of view.
 *
 * Iterative deepening: each pass searches a turn deeper and keeps the result of
 * the last pass that finished, so running out of time costs depth, not the move.
 */
export function rankTurns(state: GameState, options: SearchOptions): SearchResult {
  const started = now();
  const all = legalTurns(state, options.discChoices);
  if (all.length === 0) {
    return { scored: [], depth: 0, nodes: 0, timeMs: 0, forced: false };
  }

  const me = state.turn;
  const budget: Budget = { deadline: started + options.timeLimitMs, nodes: 0 };
  const ctx: Context = { options, me, budget, maxDepth: options.maxDepth };
  const narrow = orderPlans(all, me);

  let best: ScoredTurn[] = narrow.map((plan) => ({ plan, score: -Infinity }));
  let completedDepth = 0;
  let forced = false;

  for (let depth = 1; depth <= options.maxDepth; depth++) {
    try {
      const scored: ScoredTurn[] = [];
      let alpha = -Infinity;
      const root: Context = { ...ctx, me: OPPONENT[me] };
      for (const plan of narrow) {
        const score = -negamax(plan.next, depth - 1, -Infinity, -alpha, root);
        scored.push({ plan, score });
        if (score > alpha) alpha = score;
      }
      scored.sort((a, b) => byDescending(a.score, b.score));
      best = scored;
      completedDepth = depth;
      // A forced result is worth reporting as soon as it is certain.
      if (Math.abs(scored[0].score) > MATE - 1000) {
        forced = true;
        break;
      }
    } catch (error) {
      if (!(error instanceof Aborted)) throw error;
      break; // out of time; keep the shallower result
    }
  }

  return {
    scored: best,
    depth: completedDepth,
    nodes: budget.nodes,
    timeMs: now() - started,
    forced,
  };
}

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

export type DifficultyId = 'casual' | 'club' | 'expert' | 'master';

export interface Difficulty {
  readonly id: DifficultyId;
  readonly label: string;
  readonly blurb: string;
  readonly depth: number;
  readonly timeLimitMs: number;
  readonly discChoices: number;
  /**
   * How often to ignore the search and play a random legal turn. Even a strong
   * player should be beatable by a beginner, and no real player is perfect.
   */
  readonly randomMoveChance: number;
  /** Pick at random from this many of the best moves, to avoid being predictable. */
  readonly pickFromTop: number;
}

export const DIFFICULTIES: Readonly<Record<DifficultyId, Difficulty>> = {
  casual: {
    id: 'casual',
    label: 'Casual',
    blurb: 'Plays fast and loose, and misses what is right in front of it.',
    depth: 1,
    timeLimitMs: 350,
    discChoices: 4,
    randomMoveChance: 0.4,
    pickFromTop: 4,
  },
  club: {
    id: 'club',
    label: 'Club',
    blurb: 'Spots the obvious threats and takes a free win, but plans shallowly.',
    depth: 2,
    timeLimitMs: 900,
    discChoices: 6,
    randomMoveChance: 0.15,
    pickFromTop: 3,
  },
  expert: {
    id: 'expert',
    label: 'Expert',
    blurb: 'Plays solidly and will punish a move that leaves a hole.',
    depth: 3,
    timeLimitMs: 2000,
    discChoices: 8,
    randomMoveChance: 0.04,
    pickFromTop: 2,
  },
  master: {
    id: 'master',
    label: 'Master',
    blurb: 'Thinks a few turns ahead and rarely gives anything away.',
    depth: 5,
    timeLimitMs: 3500,
    discChoices: 10,
    randomMoveChance: 0,
    pickFromTop: 1,
  },
};

export const DIFFICULTY_ORDER: readonly DifficultyId[] = ['casual', 'club', 'expert', 'master'];

const pick = <T,>(items: readonly T[], random: () => number): T =>
  items[Math.min(items.length - 1, Math.floor(random() * items.length))];

/**
 * Turn a ranked list into the move the computer actually plays. Lower levels get
 * the shallower search, more random turns and a wider choice among near-best
 * moves, which is what makes the levels feel genuinely different to play against.
 */
export function chooseTurn(
  result: SearchResult,
  difficulty: Difficulty,
  random: () => number = Math.random,
): TurnPlan | null {
  if (result.scored.length === 0) return null;
  if (random() < difficulty.randomMoveChance) {
    return pick(result.scored, random).plan;
  }
  const pool = result.scored.slice(0, Math.max(1, difficulty.pickFromTop));
  return pick(pool, random).plan;
}

/** Search and choose in one step — what the worker and the tests both call. */
export function computerTurn(
  state: GameState,
  difficulty: Difficulty,
  options: Partial<SearchOptions> = {},
  random: () => number = Math.random,
): { plan: TurnPlan; result: SearchResult } | null {
  const searchOptions: SearchOptions = {
    maxDepth: options.maxDepth ?? difficulty.depth,
    timeLimitMs: options.timeLimitMs ?? difficulty.timeLimitMs,
    discChoices: options.discChoices ?? difficulty.discChoices,
    recent: options.recent,
  };
  const result = rankTurns(state, searchOptions);
  const plan = chooseTurn(result, difficulty, random);
  return plan ? { plan, result } : null;
}

/** Re-derive the disc step of a plan, for callers holding only the pawn move. */
export const discMoveOf = (plan: TurnPlan): DiscMove | null =>
  plan.lift && plan.place ? { kind: 'disc', from: plan.lift, to: plan.place } : null;

/** True when the lifted disc can still legally go where the plan says. */
export const discStepIsLegal = (state: GameState, move: DiscMove): boolean =>
  state.phase === 'move-disc' &&
  state.heldDisc === move.from &&
  placementCells(state).includes(move.to);

export { canSlideOut };
