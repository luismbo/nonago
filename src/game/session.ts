/**
 * A game in progress: the rules engine's state plus the bits that belong to the
 * table rather than the rules — undo, the move log, and calling it a draw when
 * the players manage to loop the same position forever.
 */

import type { CellKey } from './hex';
import {
  type DiscMove,
  type GameState,
  type PawnMove,
  type Player,
  createGame,
  declareDraw,
  liftDisc,
  movePawn,
  placeDisc,
  positionSignature,
  settle,
} from './rules';

export interface LogEntry {
  readonly turn: number;
  readonly player: Player;
  /** `null` when every pawn was walled in and the step had to be skipped. */
  readonly pawn: PawnMove | null;
  readonly disc: DiscMove | null;
}

/** How often the same position may come round again before it counts as a draw. */
export const REPETITION_LIMIT = 3;

/**
 * The physical game has no end rule beyond "someone wins", and players can
 * wander a long time without getting there. On a board that nobody can close
 * the game has to end by itself sooner or later, and a real game is over in
 * well under a hundred turns, so this only ever catches a game going nowhere.
 */
export const TURN_LIMIT = 150;

export type DrawReason = 'repetition' | 'turn-limit' | 'blocked';

interface Snapshot {
  readonly state: GameState;
  /** The pawn slid so far this turn; a turn is three steps but one log line. */
  readonly turnPawn: PawnMove | null;
  readonly logLength: number;
  readonly drawReason: DrawReason | null;
}

export class Session {
  private readonly stack: Snapshot[];
  private readonly log: LogEntry[] = [];
  private readonly seen = new Map<string, number>();

  constructor(firstPlayer: Player) {
    const start = settle(createGame({ firstPlayer }));
    this.stack = [{ state: start, turnPawn: null, logLength: 0, drawReason: null }];
  }

  get state(): GameState {
    return this.stack[this.stack.length - 1].state;
  }

  get moves(): readonly LogEntry[] {
    return this.log;
  }

  get canUndo(): boolean {
    return this.stack.length > 1;
  }

  get drawReason(): DrawReason | null {
    return this.stack[this.stack.length - 1].drawReason;
  }

  get over(): boolean {
    return this.state.phase === 'game-over';
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    this.stack.pop();
    this.log.length = this.stack[this.stack.length - 1].logLength;
    return true;
  }

  movePawn(move: PawnMove): void {
    this.commit(movePawn(this.state, move), move, null);
  }

  liftDisc(from: CellKey): void {
    this.commit(liftDisc(this.state, from), null, null);
  }

  placeDisc(move: DiscMove): void {
    if (this.state.heldDisc !== move.from) {
      throw new Error(`The disc in hand is ${this.state.heldDisc}, not ${move.from}.`);
    }
    this.commit(placeDisc(this.state, move.to), null, move);
  }

  private commit(next: GameState, pawn: PawnMove | null, disc: DiscMove | null): void {
    const before = this.state;
    const settled = settle(next);
    // A turn is one pawn slide plus one disc move, so the pawn that was slid
    // belongs to the log line even though it was committed several steps back.
    const turnPawn = pawn ?? this.stack[this.stack.length - 1].turnPawn;
    const turnOver = settled.turnNumber !== before.turnNumber || settled.phase === 'game-over';

    if (turnOver) {
      this.log.push({ turn: before.turnNumber, player: before.turn, pawn: turnPawn, disc });
    }

    let state = settled;
    let drawReason: DrawReason | null = null;
    if (state.phase === 'move-pawn' && this.repeats(state)) {
      state = declareDraw(state);
      drawReason = 'repetition';
    } else if (state.phase === 'move-pawn' && state.turnNumber > TURN_LIMIT) {
      state = declareDraw(state);
      drawReason = 'turn-limit';
    } else if (state.phase === 'game-over' && state.winner === null) {
      // Neither step was possible for anyone.
      drawReason = 'blocked';
    }

    this.stack.push({
      state,
      turnPawn: turnOver ? null : turnPawn,
      logLength: this.log.length,
      drawReason,
    });
  }

  private repeats(state: GameState): boolean {
    const signature = positionSignature(state);
    const times = (this.seen.get(signature) ?? 0) + 1;
    this.seen.set(signature, times);
    return times >= REPETITION_LIMIT;
  }
}
