/**
 * The computer opponent runs in a worker.
 *
 * Searching is the one part of this app that can hold the main thread still for
 * most of a second, which on a page this size is long enough for the board to
 * stutter and for clicks to be dropped. Out here the interface stays responsive
 * and can keep showing what is going on.
 *
 * The worker is stateless: the interface posts a position to search and gets
 * back the turn to play, together with how the search went — which is worth
 * reporting, since it is the difference between "thinking" and "stuck".
 */

import {
  DIFFICULTIES,
  type DifficultyId,
  type TurnPlan,
  computerTurn,
} from '../game/ai';
import { type GameState, createGame } from '../game/rules';

export interface ThinkRequest {
  readonly id: number;
  readonly state: GameState;
  readonly difficulty: DifficultyId;
  /** Cap on deliberation, overriding the level's own budget. */
  readonly timeLimitMs?: number;
  /** Positions already seen this game, so the search can refuse to repeat. */
  readonly recent?: string[];
}

export interface ThinkResponse {
  readonly id: number;
  readonly plan: TurnPlan | null;
  readonly depth: number;
  readonly nodes: number;
  readonly timeMs: number;
  readonly forced: boolean;
  readonly error?: string;
}

const think = (request: ThinkRequest): ThinkResponse => {
  const difficulty = DIFFICULTIES[request.difficulty];
  const found = computerTurn(request.state, difficulty, {
    timeLimitMs: request.timeLimitMs ?? difficulty.timeLimitMs,
    recent: request.recent ? new Set(request.recent) : undefined,
  });

  if (!found) {
    return { id: request.id, plan: null, depth: 0, nodes: 0, timeMs: 0, forced: false };
  }
  return {
    id: request.id,
    plan: found.plan,
    depth: found.result.depth,
    nodes: found.result.nodes,
    timeMs: found.result.timeMs,
    forced: found.result.forced,
  };
};

self.addEventListener('message', (event: MessageEvent<ThinkRequest>) => {
  try {
    self.postMessage(think(event.data));
  } catch (error) {
    // Never leave the interface waiting on a search that fell over.
    self.postMessage({
      id: event.data.id,
      plan: null,
      depth: 0,
      nodes: 0,
      timeMs: 0,
      forced: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Run one shallow search at start-up. It does nothing useful, but it makes the
// module graph and the JIT warm, so the player's first real move is not the slow one.
try {
  computerTurn(createGame(), DIFFICULTIES.casual, {
    maxDepth: 1,
    timeLimitMs: 30,
  });
} catch {
  // A cold start is not worth failing over.
}
