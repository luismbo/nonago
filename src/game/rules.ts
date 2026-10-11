/**
 * The rules of Nonaga, as a set of pure functions over an immutable state.
 *
 * A turn is always two steps, in this order:
 *
 *  1. Slide one of your pawns in a straight line. It travels as far as it can:
 *     it stops on the last disc before the edge of the field, or before another
 *     pawn. (Discs never block it — the pawn rides over them.)
 *  2. Pick up a free disc from the rim of the field and put it down somewhere
 *     that touches at least two other discs. A disc that is completely walled
 *     in by six neighbours cannot be slid out, and neither the pawn standing on
 *     it nor the disc your opponent relocated last turn may be picked up.
 */

import {
  type Cell,
  type CellKey,
  CORNER_CELLS,
  DIRECTIONS,
  INITIAL_CELLS,
  add,
  areAdjacent,
  cellKey,
  neighbours,
  parseKey,
} from './hex';

export type Player = 'red' | 'black';
export const PLAYERS: readonly Player[] = ['red', 'black'];
export const OPPONENT: Record<Player, Player> = { red: 'black', black: 'red' };

export type Phase = 'move-pawn' | 'move-disc' | 'game-over';

export interface PawnMove {
  readonly kind: 'pawn';
  readonly from: CellKey;
  readonly to: CellKey;
}

export interface DiscMove {
  readonly kind: 'disc';
  readonly from: CellKey;
  readonly to: CellKey;
}

export type Move = PawnMove | DiscMove;

export interface GameState {
  /** Cells that currently hold a disc. */
  readonly discs: ReadonlySet<CellKey>;
  /** Cells that hold a pawn, and who owns it. */
  readonly pawns: ReadonlyMap<CellKey, Player>;
  readonly turn: Player;
  readonly phase: Phase;
  /** Disc relocated on the previous turn; the opponent may not pick it up. */
  readonly lockedDisc: CellKey | null;
  /** Disc picked up during the current `move-disc` step. */
  readonly heldDisc: CellKey | null;
  readonly winner: Player | null;
  readonly turnNumber: number;
}

export interface GameOptions {
  /** Who plays the first turn. The rulebook picks this at random. */
  readonly firstPlayer?: Player;
}

export function createGame({ firstPlayer = 'red' }: GameOptions = {}): GameState {
  const discs = new Set<CellKey>(INITIAL_CELLS.map(cellKey));
  const pawns = new Map<CellKey, Player>();
  CORNER_CELLS.forEach((corner, index) => {
    pawns.set(cellKey(corner), index % 2 === 0 ? 'black' : 'red');
  });

  return {
    discs,
    pawns,
    turn: firstPlayer,
    phase: 'move-pawn',
    lockedDisc: null,
    heldDisc: null,
    winner: null,
    turnNumber: 1,
  };
}

const pawnCellsOf = (state: GameState, player: Player): CellKey[] =>
  [...state.pawns].filter(([, owner]) => owner === player).map(([cell]) => cell);

/** Number of discs touching a cell. */
const touchCount = (discs: ReadonlySet<CellKey>, cell: Cell): number =>
  neighbours(cell).filter((n) => discs.has(cellKey(n))).length;

/**
 * A pawn has won once all three of its pawns sit on neighbouring discs: the
 * only three shapes that can do that are a line, a triangle and a tick — which
 * is to say, a single connected group of three.
 */
export function isWinningShape(cells: readonly CellKey[]): boolean {
  if (cells.length !== 3) return false;
  const [a, b, c] = cells.map(parseKey);
  const touching = [areAdjacent(a, b), areAdjacent(a, c), areAdjacent(b, c)].filter(Boolean);
  return touching.length >= 2;
}

export function hasWon(state: GameState, player: Player): boolean {
  return isWinningShape(pawnCellsOf(state, player));
}

/**
 * Where a pawn ends up when slid in `direction`, or `null` when it is walled in
 * and cannot move that way at all.
 */
export function slidePawn(state: GameState, from: CellKey, direction: Cell): CellKey | null {
  let at = from;
  for (;;) {
    const next = cellKey(add(parseKey(at), direction));
    if (!state.discs.has(next)) break; // the edge of the field
    if (state.pawns.has(next)) break; // another pawn is in the way
    at = next;
  }
  return at === from ? null : at;
}

export function legalPawnMoves(state: GameState): PawnMove[] {
  if (state.phase !== 'move-pawn') return [];
  const moves: PawnMove[] = [];
  for (const [cell, owner] of state.pawns) {
    if (owner !== state.turn) continue;
    for (const direction of DIRECTIONS) {
      const to = slidePawn(state, cell, direction);
      if (to !== null) moves.push({ kind: 'pawn', from: cell, to });
    }
  }
  return moves;
}

/**
 * A disc can be slid out of the arrangement when at least one of the six cells
 * around it is empty. A disc ringed by all six neighbours is locked in place.
 */
const canSlideOut = (discs: ReadonlySet<CellKey>, disc: CellKey): boolean =>
  touchCount(discs, parseKey(disc)) < 6;

/** Discs the player in the `move-disc` step is allowed to pick up. */
export function liftableDiscs(state: GameState): CellKey[] {
  if (state.phase !== 'move-disc' || state.heldDisc !== null) return [];
  return [...state.discs].filter(
    (disc) =>
      !state.pawns.has(disc) && // must be a free disc
      disc !== state.lockedDisc && // ...not the one the opponent just relocated
      canSlideOut(state.discs, disc),
  );
}

/**
 * Empty cells where the held disc may be put down: it has to end up touching at
 * least two of the discs that are still on the table, and the rulebook has it
 * relocated to *another* position, so putting it straight back does not count.
 *
 * One exception: a disc on the tip of the field sometimes has nowhere at all
 * that two discs would let it rest. It can always go home, so the turn still
 * comes to an end.
 */
export function placementCells(state: GameState): CellKey[] {
  if (state.phase !== 'move-disc' || state.heldDisc === null) return [];
  const candidates = new Set<CellKey>();
  for (const disc of state.discs) {
    for (const n of neighbours(parseKey(disc))) candidates.add(cellKey(n));
  }
  const spots = [...candidates].filter(
    (cell) =>
      !state.discs.has(cell) &&
      cell !== state.heldDisc &&
      touchCount(state.discs, parseKey(cell)) >= 2,
  );
  return spots.length > 0 ? spots : [state.heldDisc];
}

export function legalMoves(state: GameState): Move[] {
  if (state.phase === 'move-pawn') return legalPawnMoves(state);
  if (state.phase === 'move-disc') {
    if (state.heldDisc !== null) {
      return placementCells(state).map((to) => ({ kind: 'disc' as const, from: state.heldDisc!, to }));
    }
    return liftableDiscs(state).map((from) => ({ kind: 'disc' as const, from, to: from }));
  }
  return [];
}

/** Slide a pawn, then check whether that wins the game. */
export function movePawn(state: GameState, move: PawnMove): GameState {
  if (state.phase !== 'move-pawn') {
    throw new Error('A pawn can only be moved at the start of a turn.');
  }
  const legal = legalPawnMoves(state).some((m) => m.from === move.from && m.to === move.to);
  if (!legal) throw new Error(`Illegal pawn move: ${move.from} -> ${move.to}.`);

  const owner = state.pawns.get(move.from);
  if (owner === undefined) throw new Error(`No pawn on ${move.from}.`);

  const pawns = new Map(state.pawns);
  pawns.delete(move.from);
  pawns.set(move.to, owner);

  const next: GameState = { ...state, pawns, phase: 'move-disc' };
  return hasWon(next, owner)
    ? { ...next, phase: 'game-over', winner: owner }
    : next;
}

/** Pick a free disc off the rim of the field. */
export function liftDisc(state: GameState, from: CellKey): GameState {
  if (!liftableDiscs(state).includes(from)) {
    throw new Error(`That disc cannot be moved: ${from}.`);
  }
  const discs = new Set(state.discs);
  discs.delete(from);
  return { ...state, discs, heldDisc: from };
}

/** Put the held disc down; this completes the turn and hands it to the opponent. */
export function placeDisc(state: GameState, to: CellKey): GameState {
  const { heldDisc } = state;
  if (heldDisc === null) throw new Error('No disc is being held.');
  if (!placementCells(state).includes(to)) {
    throw new Error(`A disc must touch at least two others: ${to} does not.`);
  }
  const discs = new Set(state.discs);
  discs.add(to);
  return {
    ...state,
    discs,
    heldDisc: null,
    lockedDisc: to,
    turn: OPPONENT[state.turn],
    phase: 'move-pawn',
    turnNumber: state.turnNumber + 1,
  };
}

/**
 * A pawn can end up walled in on all six sides — every direction either points
 * off the field or is blocked by another pawn. The player still gets to move a
 * disc, which is usually enough to dig a pawn back out, so an unusable pawn
 * step is simply skipped. If neither step is possible the game is drawn.
 */
export function settle(state: GameState): GameState {
  let next = state;
  for (let step = 0; step < 4; step++) {
    if (next.phase === 'game-over') return next;
    if (next.phase === 'move-pawn') {
      if (legalPawnMoves(next).length > 0) return next;
      next = { ...next, phase: 'move-disc' };
      continue;
    }
    if (next.heldDisc !== null || liftableDiscs(next).length > 0) return next;
    next = {
      ...next,
      phase: 'move-pawn',
      turn: OPPONENT[next.turn],
      turnNumber: next.turnNumber + 1,
    };
  }
  return { ...next, phase: 'game-over', winner: null };
}

export function declareDraw(state: GameState): GameState {
  return { ...state, phase: 'game-over', winner: null };
}

/**
 * A compact fingerprint of everything that matters, used to spot a game that
 * is going in circles. The turn number is left out on purpose — it changes on
 * every turn and would hide the repetition we are looking for.
 */
export function positionSignature(state: GameState): string {
  const discs = [...state.discs].sort().join(' ');
  const pawns = [...state.pawns].map(([cell, owner]) => `${cell}:${owner}`).sort().join(' ');
  return `${state.turn}|${state.lockedDisc}|${discs}|${pawns}`;
}
