import { describe, expect, it } from 'vitest';

import { INITIAL_CELLS, cellKey } from './hex';
import {
  type GameState,
  type Player,
  createGame,
  legalPawnMoves,
  liftDisc,
  liftableDiscs,
  movePawn,
  placeDisc,
  settle,
  placementCells,
} from './rules';
import { Session } from './session';
import {
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  type TurnPlan,
  adjacencyCount,
  chooseTurn,
  computerTurn,
  legalTurns,
  pawnCellsOf,
  quickScore,
  rankTurns,
  spreadOf,
  winsOnNextSlide,
} from './ai';

const key = (q: number, r: number) => cellKey({ q, r });
const field: [number, number][] = INITIAL_CELLS.map(({ q, r }) => [q, r]);

/** Above every random draw, so "random" turns are never taken by accident. */
const neverRandom = () => 0.999_999;

/** A repeatable pseudo-random source, for tests that want variety. */
const seeded = (seed: number): (() => number) => {
  let x = seed + 1;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
};

function position(
  discs: readonly (readonly [number, number])[],
  pawns: readonly (readonly [readonly [number, number], Player])[],
  turn: Player = 'red',
): GameState {
  return {
    discs: new Set(discs.map(([q, r]) => key(q, r))),
    pawns: new Map(pawns.map(([[q, r], owner]) => [key(q, r), owner])),
    turn,
    phase: 'move-pawn',
    lockedDisc: null,
    heldDisc: null,
    winner: null,
    turnNumber: 1,
  };
}

/**
 * Play a plan the way the interface does, which also proves it stays legal.
 *
 * A plan with no pawn slide has already been through `settle`, so the rules are
 * already at the disc step; one with a slide needs the same transition the real
 * interface performs before the disc can be picked up.
 */
function applyPlan(state: GameState, plan: TurnPlan): GameState {
  let next = plan.pawn ? movePawn(state, plan.pawn) : settle(state);
  if (plan.lift && plan.place) next = placeDisc(liftDisc(next, plan.lift), plan.place);
  return next;
}

describe('reading the shape of a position', () => {
  it('counts touching pairs among the three pawns', () => {
    expect(adjacencyCount([{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }])).toBe(2);
    expect(adjacencyCount([{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 0, r: 1 }])).toBe(3);
    expect(adjacencyCount([{ q: 0, r: 0 }, { q: 3, r: 0 }, { q: 0, r: 3 }])).toBe(0);
  });

  it('measures the distance still to travel before the pawns touch', () => {
    // Two pairs already touching, so nothing left to close.
    expect(spreadOf([{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 1, r: -1 }])).toBe(0);
    expect(spreadOf([{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 3, r: 2 }])).toBeGreaterThan(0);
  });

  it('sees a win that one slide away', () => {
    // Two red pawns touching; the third is across the board and cannot reach them.
    const tooFar = position(
      field,
      [
        [[-2, 0], 'red'],
        [[-2, 1], 'red'],
        [[0, -2], 'red'],
        [[-2, 2], 'black'],
        [[-1, -1], 'black'],
        [[-1, 0], 'black'],
      ],
      'red',
    );
    expect(adjacencyCount(pawnCellsOf(tooFar, 'red'))).toBe(1);
    expect(winsOnNextSlide(tooFar, 'red')).toBe(false);

    // The same pair, with the third pawn able to slide in and join them.
    const oneSlide = position(
      field,
      [
        [[-2, 0], 'red'],
        [[-2, 1], 'red'],
        [[-1, 2], 'red'],
        [[-2, 2], 'black'],
        [[-1, -1], 'black'],
        [[-1, 0], 'black'],
      ],
      'red',
    );
    expect(adjacencyCount(pawnCellsOf(oneSlide, 'red'))).toBe(1);
    expect(winsOnNextSlide(oneSlide, 'red')).toBe(true);
  });

  it('will not look for a win that is not there to find', () => {
    const scattered = position(
      field,
      [
        [[-2, 2], 'red'],
        [[0, -2], 'red'],
        [[2, -2], 'red'],
        [[0, 0], 'black'],
        [[1, 0], 'black'],
        [[1, -1], 'black'],
      ],
      'black',
    );
    // Red has no touching pair, so no single slide can complete one.
    expect(winsOnNextSlide(scattered, 'red')).toBe(false);
  });

  it('rates the board from the point of view of the player to move', () => {
    const strong = position(
      field,
      [
        [[0, 0], 'red'],
        [[1, 0], 'red'],
        [[1, -1], 'red'],
        [[-2, 2], 'black'],
        [[0, -2], 'black'],
        [[2, -2], 'black'],
      ],
      'red',
    );
    const weak = position(
      field,
      [
        [[-2, 2], 'red'],
        [[0, -2], 'red'],
        [[2, -2], 'red'],
        [[0, 0], 'black'],
        [[1, 0], 'black'],
        [[1, -1], 'black'],
      ],
      'red',
    );
    expect(quickScore(strong, 'red')).toBeGreaterThan(quickScore(weak, 'red'));
    // The same board is worth less to the other side.
    expect(quickScore(strong, 'black')).toBeLessThan(0);
  });

  it('lists each player three pawns', () => {
    const game = createGame();
    expect(pawnCellsOf(game, 'red')).toHaveLength(3);
    expect(pawnCellsOf(game, 'black')).toHaveLength(3);
  });
});

describe('generating turns', () => {
  it('covers every legal pawn slide', () => {
    const game = createGame();
    const plans = legalTurns(game, Number.POSITIVE_INFINITY);
    for (const move of legalPawnMoves(game)) {
      expect(plans.some((p) => p.pawn?.from === move.from && p.pawn?.to === move.to)).toBe(true);
    }
  });

  it('only produces turns that are legal step by step', () => {
    const game = createGame();
    for (const plan of legalTurns(game, Number.POSITIVE_INFINITY)) {
      const afterPawn = movePawn(game, plan.pawn!);
      if (afterPawn.phase === 'game-over') continue;
      expect(liftableDiscs(afterPawn)).toContain(plan.lift);
      expect(placementCells(liftDisc(afterPawn, plan.lift!))).toContain(plan.place);
      expect(applyPlan(game, plan)).toEqual(plan.next);
    }
  });

  it('gives a narrowed list whose turns all really are legal', () => {
    const game = createGame();
    for (const plan of legalTurns(game, 6)) {
      expect(() => applyPlan(game, plan)).not.toThrow();
      expect(applyPlan(game, plan)).toEqual(plan.next);
    }
    // Narrowing should cut the branching factor down without emptying the list.
    expect(legalTurns(game, 6).length).toBeLessThan(
      legalTurns(game, Number.POSITIVE_INFINITY).length,
    );
  });

  it('offers nothing once the game is over', () => {
    const over: GameState = { ...createGame(), phase: 'game-over', winner: 'red' };
    expect(legalTurns(over)).toHaveLength(0);
    expect(legalTurns(over, Number.POSITIVE_INFINITY)).toHaveLength(0);
  });

  it('still finds a way to move when the pawns are all walled in', () => {
    // Red's three pawns each sit alone on an isolated disc, so every direction
    // runs off the field and the slide step is skipped: the turn can only be
    // completed by relocating a disc from the cluster on the right.
    const discs: [number, number][] = [
      [0, 0],
      [12, 0],
      [0, 12],
      [24, 0],
      [25, 0],
      [25, -1],
      [25, 1],
      [24, 1],
      [24, -1],
      [23, -1],
    ];
    const stuck = position(
      discs,
      [
        [[0, 0], 'red'],
        [[12, 0], 'red'],
        [[0, 12], 'red'],
        [[24, 0], 'black'],
        [[25, -1], 'black'],
        [[25, 1], 'black'],
      ],
      'red',
    );
    expect(legalPawnMoves(stuck)).toHaveLength(0);

    const plans = legalTurns(stuck, Number.POSITIVE_INFINITY);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(plan.pawn).toBeNull();
      expect(() => applyPlan(stuck, plan)).not.toThrow();
    }
  });
});

describe('searching', () => {
  it('returns every turn scored, best first', () => {
    const result = rankTurns(createGame(), {
      maxDepth: 2,
      timeLimitMs: 1500,
      discChoices: 6,
    });
    expect(result.scored.length).toBeGreaterThan(0);
    for (let i = 1; i < result.scored.length; i++) {
      expect(result.scored[i - 1].score).toBeGreaterThanOrEqual(result.scored[i].score);
    }
  });

  it('takes a win that is on the board', () => {
    // Red: two pawns touching, and a third one slide from joining them.
    const game = position(
      field,
      [
        [[-2, 0], 'red'],
        [[-2, 1], 'red'],
        [[-1, 2], 'red'],
        [[0, -2], 'black'],
        [[2, -2], 'black'],
        [[2, 2], 'black'],
      ],
      'red',
    );
    expect(winsOnNextSlide(game, 'red')).toBe(true);
    const { plan, result } = computerTurn(game, DIFFICULTIES.master, undefined, neverRandom)!;
    expect(plan.next.phase).toBe('game-over');
    expect(plan.next.winner).toBe('red');
    expect(result.forced).toBe(true);
  });

  it('takes the win when red is one slide from it', () => {
    const game = position(
      field,
      [
        [[-2, 0], 'red'],
        [[-2, 1], 'red'],
        [[-1, 2], 'red'],
        [[-2, 2], 'black'],
        [[-1, -1], 'black'],
        [[-1, 0], 'black'],
      ],
      'red',
    );
    expect(winsOnNextSlide(game, 'red')).toBe(true);
    const { plan } = computerTurn(game, DIFFICULTIES.master, undefined, neverRandom)!;
    expect(plan.next.winner).toBe('red');
  });

  it('looks one move further than a bare threat check', () => {
    // Black to move with no immediate threat either way. The point is that the
    // search must not merely avoid losing; it should leave its own pawns better
    // placed than any alternative it was offered.
    const game = position(
      field,
      [
        [[0, 0], 'red'],
        [[1, 0], 'red'],
        [[-2, 2], 'red'],
        [[2, -2], 'black'],
        [[2, 0], 'black'],
        [[0, 2], 'black'],
      ],
      'black',
    );
    const result = rankTurns(game, { maxDepth: 3, timeLimitMs: 2500, discChoices: 8 });
    const { plan, result: again } = computerTurn(
      game,
      DIFFICULTIES.master,
      undefined,
      neverRandom,
    )!;
    // The turn it plays is one it scored at least as highly as anything else.
    const chosen = again.scored.find((entry) => entry.plan.next.winner === plan.next.winner &&
      entry.plan.pawn?.to === plan.pawn?.to && entry.plan.pawn?.from === plan.pawn?.from &&
      entry.plan.place === plan.place);
    expect(chosen).toBeDefined();
    expect(chosen!.score).toBe(again.scored[0].score);
    expect(result.scored[0].score).toBeGreaterThanOrEqual(
      result.scored[result.scored.length - 1].score,
    );
  });

  it('never claims a win that has not happened', () => {
    const game = createGame();
    for (const id of DIFFICULTY_ORDER) {
      const { plan } = computerTurn(game, DIFFICULTIES[id], undefined, neverRandom)!;
      expect(plan.next.winner).toBeNull();
    }
  });

  it('stays inside its time budget however long it is allowed', () => {
    const game = createGame();
    for (const budget of [20, 60, 200, 600]) {
      const started = performance.now();
      const result = rankTurns(game, { maxDepth: 30, timeLimitMs: budget, discChoices: 8 });
      const elapsed = performance.now() - started;
      expect(result.scored.length).toBeGreaterThan(0);
      // A single node can overshoot slightly, but nothing like a whole pass.
      expect(elapsed, `budget ${budget}ms`).toBeLessThan(budget + 600);
    }
  });

  it('still returns a move when given almost no time at all', () => {
    const game = createGame();
    const result = rankTurns(game, { maxDepth: 8, timeLimitMs: 1, discChoices: 2 });
    expect(result.scored.length).toBeGreaterThan(0);
  });

  it('looks further ahead with more depth', () => {
    const game = createGame();
    const shallow = rankTurns(game, { maxDepth: 1, timeLimitMs: 2000, discChoices: 6 });
    const deeper = rankTurns(game, { maxDepth: 3, timeLimitMs: 4000, discChoices: 6 });
    expect(deeper.depth).toBeGreaterThanOrEqual(shallow.depth);
    expect(deeper.nodes).toBeGreaterThan(shallow.nodes);
  });
});

describe('the four levels', () => {
  it('get progressively deeper and less erratic', () => {
    expect(DIFFICULTY_ORDER).toEqual(['casual', 'club', 'expert', 'master']);
    const levels = DIFFICULTY_ORDER.map((id) => DIFFICULTIES[id]);
    for (const level of levels) {
      expect(level.depth).toBeGreaterThan(0);
      expect(level.timeLimitMs).toBeGreaterThan(0);
      expect(level.blurb).toBeTruthy();
      expect(level.label).toBeTruthy();
    }
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i].depth).toBeGreaterThanOrEqual(levels[i - 1].depth);
      expect(levels[i].timeLimitMs).toBeGreaterThanOrEqual(levels[i - 1].timeLimitMs);
      expect(levels[i].randomMoveChance).toBeLessThanOrEqual(levels[i - 1].randomMoveChance);
    }
    expect(DIFFICULTIES.master.randomMoveChance).toBe(0);
    expect(DIFFICULTIES.casual.randomMoveChance).toBeGreaterThan(0.2);
  });

  it('each plays a legal turn, every time', () => {
    const game = createGame();
    for (const id of DIFFICULTY_ORDER) {
      for (let seed = 0; seed < 12; seed++) {
        const { plan } = computerTurn(game, DIFFICULTIES[id], undefined, seeded(seed))!;
        expect(() => applyPlan(game, plan)).not.toThrow();
        expect(applyPlan(game, plan)).toEqual(plan.next);
      }
    }
  });

  it('does not answer the same position the same way every time', () => {
    const game = createGame();
    const replies = new Set<string>();
    for (let seed = 0; seed < 16; seed++) {
      const { plan } = computerTurn(game, DIFFICULTIES.club, undefined, seeded(seed))!;
      replies.add(`${plan.pawn?.from ?? '-'}->${plan.pawn?.to ?? '-'}`);
    }
    expect(replies.size).toBeGreaterThan(1);
  });

  it('the top level takes the best move it found', () => {
    const result = rankTurns(createGame(), {
      maxDepth: 2,
      timeLimitMs: 1500,
      discChoices: 6,
    });
    expect(chooseTurn(result, DIFFICULTIES.master, neverRandom)).toBe(result.scored[0].plan);
  });

  it('the loosest level does sometimes ignore the search', () => {
    const result = rankTurns(createGame(), {
      maxDepth: 2,
      timeLimitMs: 1500,
      discChoices: 6,
    });
    const choices = new Set<TurnPlan>();
    for (let seed = 0; seed < 40; seed++) {
      const pick = chooseTurn(result, DIFFICULTIES.casual, seeded(seed));
      if (pick) choices.add(pick);
    }
    expect(choices.size).toBeGreaterThan(1);
  });

  it('has nothing to return when the game is over', () => {
    const over: GameState = { ...createGame(), phase: 'game-over', winner: 'black' };
    expect(computerTurn(over, DIFFICULTIES.master)).toBeNull();
  });
});

describe('a whole game played by the computer', () => {
  it('runs to a finish making only legal moves', () => {
    const session = new Session('red');
    let steps = 0;

    while (!session.over && steps < 2000) {
      const legal = legalTurns(session.state, Number.POSITIVE_INFINITY);
      expect(legal.length, `turn ${session.state.turnNumber}`).toBeGreaterThan(0);
      const { plan } = computerTurn(session.state, DIFFICULTIES.club, undefined, neverRandom)!;
      // Whichever list it came from, the turn must be one the rules allow.
      const fresh = legalTurns(session.state, Number.POSITIVE_INFINITY);
      expect(fresh.length).toBe(legal.length);

      if (plan.pawn) session.movePawn(plan.pawn);
      if (plan.lift && plan.place) {
        expect(liftableDiscs(session.state)).toContain(plan.lift);
        session.liftDisc(plan.lift);
        session.placeDisc({ kind: 'disc', from: plan.lift, to: plan.place });
      }
      expect(session.state.discs.size).toBe(19);
      steps++;
    }

    expect(session.over).toBe(true);
    expect(session.moves.length).toBeGreaterThan(0);
  });

  it('keeps the board at nineteen discs with every pawn still standing', () => {
    const session = new Session('black');
    let steps = 0;
    while (!session.over && steps < 600) {
      const { plan } = computerTurn(session.state, DIFFICULTIES.casual, undefined, seeded(steps))!;
      if (plan.pawn) session.movePawn(plan.pawn);
      if (plan.lift && plan.place) {
        session.liftDisc(plan.lift);
        session.placeDisc({ kind: 'disc', from: plan.lift, to: plan.place });
      }
      steps++;
    }
    const { state } = session;
    expect(state.discs.size).toBe(19);
    expect(state.pawns.size).toBe(6);
    for (const pawn of state.pawns.keys()) expect(state.discs.has(pawn)).toBe(true);
  });

  it('is beaten more often than not by the strongest level', () => {
    let strong = 0;
    let played = 0;

    for (let game = 0; game < 4; game++) {
      const strongColour: Player = game % 2 === 0 ? 'red' : 'black';
      const session = new Session(strongColour);
      let steps = 0;
      while (!session.over && steps < 700) {
        const mine = session.state.turn === strongColour;
        const level = mine ? DIFFICULTIES.master : DIFFICULTIES.casual;
        const { plan } = computerTurn(session.state, level, undefined, seeded(steps + game * 31))!;
        if (plan.pawn) session.movePawn(plan.pawn);
        if (plan.lift && plan.place) {
          session.liftDisc(plan.lift);
          session.placeDisc({ kind: 'disc', from: plan.lift, to: plan.place });
        }
        steps++;
      }
      if (session.state.winner) {
        played++;
        if (session.state.winner === strongColour) strong++;
      }
    }

    expect(played).toBeGreaterThan(0);
    expect(strong).toBeGreaterThanOrEqual(played / 2);
  });
});
