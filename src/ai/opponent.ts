/**
 * Driving the computer opponent from the page.
 *
 * The search itself lives in a worker (see `worker.ts`); this wraps it in
 * promises, keeps one request in flight at a time, and makes sure a plan is
 * still legal by the time it arrives — the position may have changed underneath
 * it if the player pressed undo or started a new game mid-thought.
 */

import {
  DIFFICULTIES,
  type Difficulty,
  type DifficultyId,
  type TurnPlan,
  computerTurn,
} from '../game/ai';
import {
  type GameState,
  liftDisc,
  liftableDiscs,
  movePawn,
  placeDisc,
  placementCells,
} from '../game/rules';
import type { ThinkRequest, ThinkResponse } from './worker';

export interface Thinking {
  readonly depth: number;
  readonly nodes: number;
  readonly timeMs: number;
  readonly forced: boolean;
}

export type OpponentResult =
  | { readonly ok: true; readonly plan: TurnPlan; readonly thinking: Thinking }
  | { readonly ok: false; readonly reason: 'no-move' | 'stale' | 'failed' };

export class Opponent {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending: { id: number; resolve: (r: ThinkResponse | null) => void } | null = null;

  /**
   * Ask for a turn. Falls back to searching on this thread if workers are
   * unavailable, so the game still plays — just without a responsive board.
   */
  async think(
    state: GameState,
    difficulty: DifficultyId,
    isStale: () => boolean,
  ): Promise<OpponentResult> {
    const level: Difficulty = DIFFICULTIES[difficulty];

    if (typeof Worker === 'undefined') return this.thinkInline(state, level, isStale);

    try {
      const worker = this.ensureWorker();
      const id = this.nextId++;

      const answer = await new Promise<ThinkResponse | null>((resolve) => {
        const timer = setTimeout(() => {
          // Do not leave the board locked up waiting for a search that hung.
          if (this.pending?.id === id) {
            this.pending = null;
            worker.terminate();
            this.worker = null;
            resolve(null);
          }
        }, level.timeLimitMs + 4000);

        this.pending = {
          id,
          resolve: (response: ThinkResponse | null) => {
            clearTimeout(timer);
            this.pending = null;
            resolve(response);
          },
        };
        const request: ThinkRequest = { id, state, difficulty };
        worker.postMessage(request);
      });

      if (!answer || !answer.plan) return this.thinkInline(state, level, isStale);
      if (isStale()) return { ok: false, reason: 'stale' };
      return {
        ok: true,
        plan: answer.plan,
        thinking: {
          depth: answer.depth,
          nodes: answer.nodes,
          timeMs: answer.timeMs,
          forced: answer.forced,
        },
      };
    } catch {
      return this.thinkInline(state, level, isStale);
    }
  }

  /** Search on this thread. Used as a fallback, never as the normal path. */
  private thinkInline(
    state: GameState,
    level: Difficulty,
    isStale: () => boolean,
  ): OpponentResult {
    const found = computerTurn(state, level);
    if (!found) return { ok: false, reason: 'no-move' };
    if (isStale()) return { ok: false, reason: 'stale' };
    return {
      ok: true,
      plan: found.plan,
      thinking: {
        depth: found.result.depth,
        nodes: found.result.nodes,
        timeMs: found.result.timeMs,
        forced: found.result.forced,
      },
    };
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (event: MessageEvent<ThinkResponse>) => {
      const waiting = this.pending;
      if (!waiting || waiting.id !== event.data.id) return;
      waiting.resolve(event.data);
    });
    this.worker.addEventListener('error', () => {
      const waiting = this.pending;
      this.pending = null;
      this.worker?.terminate();
      this.worker = null;
      waiting?.resolve({ id: waiting.id, plan: null, depth: 0, nodes: 0, timeMs: 0, forced: false });
    });
    return this.worker;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending = null;
  }
}

/**
 * Play a plan out as the same three steps the interface uses.
 *
 * Re-checked against the live rules at every step rather than trusted: a plan is
 * a suggestion about a position, and this is where it has to become a legal move.
 */
export function applyPlanSteps(
  state: GameState,
  plan: TurnPlan,
  onStep: (state: GameState, step: 'pawn' | 'lift' | 'place') => GameState,
): GameState {
  let next = state;

  if (plan.pawn) {
    const legal = movePawn(next, plan.pawn);
    onStep(legal, 'pawn');
    next = legal;
  }
  if (plan.lift && plan.place) {
    if (!liftableDiscs(next).includes(plan.lift)) return next;
    const held = liftDisc(next, plan.lift);
    onStep(held, 'lift');
    next = held;
    if (placementCells(next).includes(plan.place)) {
      const placed = placeDisc(next, plan.place);
      onStep(placed, 'place');
      next = placed;
    }
  }
  return next;
}
