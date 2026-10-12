import { describe, expect, it } from 'vitest';

import { INITIAL_CELLS, cellKey } from './hex';
import {
  type GameState,
  type Player,
  createGame,
  legalPawnMoves,
  liftableDiscs,
  placementCells,
  settle,
} from './rules';
import { Session } from './session';

const key = (q: number, r: number) => cellKey({ q, r });

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

/** Can the player on move actually do something? */
const playable = (state: GameState): boolean =>
  state.phase === 'game-over' ||
  (state.phase === 'move-pawn' && legalPawnMoves(state).length > 0) ||
  (state.phase === 'move-disc' && state.heldDisc !== null && placementCells(state).length > 0) ||
  (state.phase === 'move-disc' && state.heldDisc === null && liftableDiscs(state).length > 0);

describe('undo', () => {
  it('steps back through a turn and can be repeated', () => {
    const session = new Session('red');
    const start = session.state;
    expect(session.canUndo).toBe(false);
    expect(session.undo()).toBe(false);

    session.movePawn(legalPawnMoves(start)[0]);
    expect(session.state.phase).toBe('move-disc');

    session.undo();
    expect(session.state).toEqual(start);
  });

  it('rewinds a whole turn, log and all', () => {
    const session = new Session('red');
    session.movePawn(legalPawnMoves(session.state)[0]);
    const from = liftableDiscs(session.state)[0];
    session.liftDisc(from);
    const held = session.state.heldDisc!;
    session.placeDisc({ kind: 'disc', from: held, to: placementCells(session.state)[0] });
    expect(session.moves).toHaveLength(1);
    expect(session.state.turnNumber).toBe(2);

    session.undo(); // disc back into hand
    expect(session.state.heldDisc).not.toBeNull();
    session.undo(); // disc back on the table
    expect(session.state.heldDisc).toBeNull();
    session.undo(); // pawn back where it was
    expect(session.state.turnNumber).toBe(1);
    expect(session.moves).toHaveLength(0);
    expect(session.canUndo).toBe(false);
  });
});

describe('a session only ever hands back a playable position', () => {
  /**
   * Undo restores a snapshot verbatim. If that snapshot is one the rules would
   * have skipped past — a player with no pawn slide — the game would sit there
   * with nothing to click and nothing to trigger a move. Settling on the way in
   * has to be enough for that not to happen.
   */
  it('every position it can return to offers a move', () => {
    const session = new Session('red');

    for (let turn = 0; turn < 25 && !session.over; turn++) {
      const slides = legalPawnMoves(session.state);
      if (slides.length > 0) {
        session.movePawn(slides[0]);
      } else {
        const liftable = liftableDiscs(session.state);
        if (liftable.length === 0) break;
        session.liftDisc(liftable[0]);
        const held = session.state.heldDisc!;
        const spots = placementCells(session.state);
        if (spots.length === 0) break;
        session.placeDisc({ kind: 'disc', from: held, to: spots[0] });
        continue;
      }

      if (session.state.heldDisc === null && session.state.phase !== 'game-over') {
        const liftable = liftableDiscs(session.state);
        if (liftable.length > 0) {
          session.liftDisc(liftable[0]);
          const held = session.state.heldDisc!;
          const spots = placementCells(session.state);
          if (spots.length === 0) break;
          session.placeDisc({ kind: 'disc', from: held, to: spots[0] });
        }
      }

      expect(playable(session.state), `dead position on turn ${turn}`).toBe(true);

      // Walk all the way back and check every position on the way.
      while (session.canUndo) {
        session.undo();
        expect(
          playable(session.state),
          `unwound to a dead position: phase=${session.state.phase} turn=${session.state.turn}`,
        ).toBe(true);
      }
      // Put the turn back so the loop can continue.
      session.movePawn(legalPawnMoves(session.state)[0]);
      break;
    }
  });

  it('a position unwound to behaves exactly like one arrived at directly', () => {
    const session = new Session('red');
    session.movePawn(legalPawnMoves(session.state)[0]);
    session.undo();

    const restored = session.state;
    const fresh = createGame({ firstPlayer: 'red' });
    expect(restored).toEqual(fresh);
    expect(settle(restored)).toEqual(settle(fresh));
  });
});

describe('positions the rules skip past', () => {
  const trapped = position(
    [
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
    ],
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

  it('moves the turn on to the disc when no pawn can slide', () => {
    expect(legalPawnMoves(trapped)).toHaveLength(0);
    const settled = settle(trapped);
    expect(settled.phase).toBe('move-disc');
    expect(liftableDiscs(settled).length).toBeGreaterThan(0);
  });

  it('declares a draw when neither step is possible at all', () => {
    const hopeless = position(
      [
        [0, 0],
        [1, 0],
        [1, -1],
        [2, 0],
        [2, -1],
        [3, 0],
      ],
      [
        [[0, 0], 'red'],
        [[2, 0], 'red'],
        [[3, 0], 'red'],
        [[1, 0], 'black'],
        [[1, -1], 'black'],
        [[2, -1], 'black'],
      ],
      'red',
    );
    expect(legalPawnMoves(hopeless)).toHaveLength(0);
    const settled = settle(hopeless);
    expect(settled.phase).toBe('game-over');
    expect(settled.winner).toBeNull();
  });
});

describe('the starting board', () => {
  it('offers nine pawn slides and a rim of discs to move', () => {
    const game = createGame();
    expect(game.discs.size).toBe(INITIAL_CELLS.length);
    expect(legalPawnMoves(game)).toHaveLength(9);
  });
});
