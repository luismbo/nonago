import { describe, expect, it } from 'vitest';

import {
  BOARD_RADIUS,
  CORNER_CELLS,
  type CellKey,
  INITIAL_CELLS,
  add,
  canSlideOut,
  cellKey,
  hexDistance,
  neighbours,
  parseKey,
} from './hex';
import {
  type GameState,
  type Player,
  createGame,
  hasWon,
  isWinningShape,
  legalMoves,
  legalPawnMoves,
  liftDisc,
  liftableDiscs,
  movePawn,
  placeDisc,
  placementCells,
  positionSignature,
  settle,
  slidePawn,
} from './rules';
import { Session, TURN_LIMIT } from './session';

const key = (q: number, r: number) => cellKey({ q, r });

/** The 19 starting cells, as plain tuples. */
const field: [number, number][] = INITIAL_CELLS.map(({ q, r }) => [q, r]);

/** Build a position by hand, for tests that need an unusual board. */
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

/** The six non-corner discs on the rim of the starting hexagon. */
const RIM_MIDDLES = [key(-1, -1), key(1, -2), key(2, -1), key(-2, 1), key(-1, 2), key(1, 1)];

/** Put the held disc down on any legal spot apart from `avoid`. */
function placeAvoiding(state: GameState, avoid: CellKey): GameState {
  const spot = placementCells(state).find((cell) => cell !== avoid);
  if (spot === undefined) throw new Error(`No free spot apart from ${avoid}.`);
  return placeDisc(state, spot);
}

/** A disc with all six neighbours on the board cannot be slid out. */
const isWalledIn = (q: number, r: number) =>
  neighbours({ q, r }).every((n) => INITIAL_CELLS.some((c) => c.q === n.q && c.r === n.r));

/** Build a disc set from [q, r] pairs. */
const boardOf = (cells: readonly (readonly [number, number])[]) =>
  new Set(cells.map(([q, r]) => key(q, r)));

describe('hex board', () => {
  it('starts from a hexagon of 19 discs', () => {
    expect(INITIAL_CELLS).toHaveLength(19);
  });

  it('gives every cell at most six neighbours, all one step away', () => {
    for (const cell of INITIAL_CELLS) {
      const onBoard = neighbours(cell).filter((n) =>
        INITIAL_CELLS.some((c) => c.q === n.q && c.r === n.r),
      );
      expect(onBoard.length).toBeLessThanOrEqual(6);
      for (const n of onBoard) expect(hexDistance(cell, n)).toBe(1);
    }
  });

  it('has six corners, each touching only three other discs', () => {
    expect(CORNER_CELLS).toHaveLength(6);
    for (const corner of CORNER_CELLS) {
      const onBoard = neighbours(corner).filter((n) =>
        INITIAL_CELLS.some((c) => c.q === n.q && c.r === n.r),
      );
      expect(onBoard).toHaveLength(3);
    }
  });

  it('puts every corner at the rim of the hexagon', () => {
    for (const corner of CORNER_CELLS) {
      expect(hexDistance(corner, { q: 0, r: 0 })).toBe(BOARD_RADIUS);
    }
  });

  it('adds cells component-wise', () => {
    expect(add({ q: 1, r: -1 }, { q: -1, r: 1 })).toEqual({ q: 0, r: 0 });
  });
});

describe('setup', () => {
  it('places 19 discs and 6 pawns', () => {
    const game = createGame();
    expect(game.discs.size).toBe(19);
    expect(game.pawns.size).toBe(6);
  });

  it('starts with nobody winning', () => {
    const game = createGame();
    expect(hasWon(game, 'red')).toBe(false);
    expect(hasWon(game, 'black')).toBe(false);
  });

  it('alternates black and red around the corners, clockwise from the top-left', () => {
    const game = createGame();
    expect(CORNER_CELLS.map((corner) => game.pawns.get(cellKey(corner)))).toEqual([
      'black',
      'red',
      'black',
      'red',
      'black',
      'red',
    ]);
  });

  it('gives each player three pawns and no more', () => {
    const game = createGame();
    for (const player of ['red', 'black'] as const) {
      expect([...game.pawns.values()].filter((o) => o === player)).toHaveLength(3);
    }
  });

  it('lets the chosen player open the game', () => {
    expect(createGame({ firstPlayer: 'black' }).turn).toBe('black');
  });
});

describe('sliding a pawn', () => {
  it('offers the red corner pawn exactly the three moves in the rulebook', () => {
    const game = createGame();
    const targets = legalPawnMoves(game)
      .filter((move) => move.from === key(2, -2))
      .map((move) => move.to);
    expect(targets.sort()).toEqual([key(-1, 1), key(1, -2), key(2, -1)].sort());
  });

  it('offers three moves from every corner of the board', () => {
    for (const firstPlayer of ['red', 'black'] as const) {
      const game = createGame({ firstPlayer });
      for (const corner of CORNER_CELLS) {
        if (game.pawns.get(cellKey(corner)) !== firstPlayer) continue;
        const options = legalPawnMoves(game).filter((m) => m.from === cellKey(corner));
        expect(options, `${corner.q},${corner.r} for ${firstPlayer}`).toHaveLength(3);
      }
      // Three pawns, three directions each.
      expect(legalPawnMoves(game)).toHaveLength(9);
    }
  });

  it('travels right across the board, over the discs in between', () => {
    const game = createGame();
    // The red pawn on the left corner slides east until the black pawn on the
    // right corner stops it one cell short.
    expect(slidePawn(game, key(-2, 0), { q: 1, r: 0 })).toBe(key(1, 0));
  });

  it('stops just before another pawn', () => {
    const game = createGame();
    // Top-right corner heading north-west meets nothing; heading west it stops
    // short of the black pawn in the top-left corner.
    expect(slidePawn(game, key(2, -2), { q: -1, r: 0 })).toBe(key(1, -2));
  });

  it('stops at the last disc when the field has a gap', () => {
    const game = createGame();
    // Punch a hole in the left flank; a pawn sliding west must stop before it.
    const holed: GameState = {
      ...game,
      discs: new Set([...game.discs].filter((c) => c !== key(-2, 0))),
    };
    expect(slidePawn(holed, key(0, 0), { q: -1, r: 0 })).toBe(key(-1, 0));
  });

  it('cannot slide off the edge of the field', () => {
    const game = createGame();
    // Three of the six directions point straight out of the hexagon.
    expect(slidePawn(game, key(2, -2), { q: 1, r: -1 })).toBeNull();
    expect(slidePawn(game, key(2, -2), { q: 0, r: -1 })).toBeNull();
    expect(slidePawn(game, key(2, -2), { q: 1, r: 0 })).toBeNull();
  });

  it('refuses a move that is not on the list', () => {
    const game = createGame();
    // Two cells along the same line is not where the pawn actually stops.
    expect(() => movePawn(game, { kind: 'pawn', from: key(2, -2), to: key(0, -2) })).toThrow(
      /Illegal/,
    );
  });

  it('refuses to move the opponent pawns', () => {
    const game = createGame();
    expect(() => movePawn(game, { kind: 'pawn', from: key(0, -2), to: key(1, -2) })).toThrow(
      /Illegal/,
    );
  });

  it('refuses a second pawn move in the same turn', () => {
    const game = createGame();
    const moved = movePawn(game, { kind: 'pawn', from: key(-2, 0), to: key(1, 0) });
    expect(() => movePawn(moved, { kind: 'pawn', from: key(2, -2), to: key(-1, 1) })).toThrow(
      /start of a turn/,
    );
  });
});

describe('winning', () => {
  it('accepts a straight line', () => {
    expect(isWinningShape([key(0, 0), key(1, 0), key(2, 0)])).toBe(true);
  });

  it('accepts a tick', () => {
    expect(isWinningShape([key(0, 0), key(1, 0), key(1, -1)])).toBe(true);
  });

  it('accepts a triangle', () => {
    expect(isWinningShape([key(0, 0), key(1, 0), key(0, 1)])).toBe(true);
  });

  it('rejects three pawns with only one touching pair', () => {
    expect(isWinningShape([key(0, 0), key(1, 0), key(3, 0)])).toBe(false);
  });

  it('rejects three pawns that are not touching at all', () => {
    expect(isWinningShape([key(0, 0), key(3, 0), key(0, 3)])).toBe(false);
  });

  it('needs all three pawns', () => {
    expect(isWinningShape([key(0, 0), key(1, 0)])).toBe(false);
  });

  it('ends the game as soon as the third pawn lands', () => {
    // Two red pawns already touching in a column; the third slides north-east
    // to complete the line.
    const game = position(
      field,
      [
        [[1, 0], 'red'],
        [[1, 1], 'red'],
        [[-2, 2], 'red'],
        [[-2, 0], 'black'],
        [[0, -2], 'black'],
        [[2, -2], 'black'],
      ],
    );
    expect(hasWon(game, 'red')).toBe(false);
    const moved = movePawn(game, { kind: 'pawn', from: key(-2, 2), to: key(1, -1) });
    expect(moved.winner).toBe('red');
    expect(moved.phase).toBe('game-over');
  });

  it('does not award the game to the player whose turn it is not', () => {
    const game = position(
      field,
      [
        [[0, 0], 'red'],
        [[1, 0], 'red'],
        [[2, 0], 'red'],
        [[-2, 0], 'black'],
        [[0, -2], 'black'],
        [[2, -2], 'black'],
      ],
      'black',
    );
    expect(hasWon(game, 'red')).toBe(true);
    expect(hasWon(game, 'black')).toBe(false);
  });
});

describe('sliding a disc out', () => {
  const at = (neighbours: readonly (readonly [number, number])[]) =>
    canSlideOut(boardOf(neighbours), { q: 0, r: 0 });

  it('takes a lone disc, or one with a single neighbour', () => {
    expect(at([])).toBe(true);
    expect(at([[1, 0]])).toBe(true);
  });

  it('takes a disc with two neighbours side by side', () => {
    expect(at([[1, 0], [1, -1]])).toBe(true);
  });

  it('takes a disc with three neighbours in a row, like a corner', () => {
    expect(at([[1, 0], [1, -1], [0, -1]])).toBe(true);
  });

  it('takes a disc with four neighbours in a row, like an edge', () => {
    // A 180 degree gap: exactly clear, as in the rulebook's own example.
    expect(at([[1, 0], [1, -1], [0, -1], [-1, 0]])).toBe(true);
  });

  it('refuses a disc with neighbours all the way round', () => {
    expect(
      at([
        [1, 0],
        [1, -1],
        [0, -1],
        [-1, 0],
        [-1, 1],
        [0, 1],
      ]),
    ).toBe(false);
  });

  it('refuses five neighbours, even though one cell is empty', () => {
    // This is the case the old count-based rule got wrong: a disc with an empty
    // space beside it, but only 120 degrees to slide through.
    expect(at([[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1]])).toBe(false);
  });

  it('refuses three neighbours spread wide around it', () => {
    // Every gap is 120 degrees; not one direction is clear.
    expect(at([[1, 0], [0, -1], [-1, 1]])).toBe(false);
  });

  it('refuses four neighbours with a gap too small to slide through', () => {
    expect(at([[1, 0], [1, -1], [0, -1], [-1, 1]])).toBe(false);
  });

  it('only cares about neighbours, not about discs further away', () => {
    expect(at([[1, 0], [2, 0], [3, 0], [1, -1], [0, -1]])).toBe(true);
  });

  it('agrees with the starting board: the rim is loose, the middle is not', () => {
    const board = boardOf(field);
    let loose = 0;
    for (const cell of INITIAL_CELLS) {
      const canLeave = canSlideOut(board, cell);
      if (canLeave) loose++;
      // Corners (3 neighbours) and edges (4 in a row) come free; the seven
      // discs in the middle have all six neighbours and are locked in.
      expect(canLeave, `${cell.q},${cell.r}`).toBe(!isWalledIn(cell.q, cell.r));
    }
    expect(loose).toBe(12);
  });
});

describe('moving a disc', () => {
  it('opens the rim once a pawn has been slid', () => {
    // Nothing can be lifted before the pawn step; afterwards the rim is fair game.
    const game = createGame();
    expect(liftableDiscs(game)).toHaveLength(0);

    const moved = movePawn(game, { kind: 'pawn', from: key(-2, 0), to: key(1, 0) });
    const liftable = liftableDiscs(moved);
    // The six rim discs between the corners, plus the corner the pawn just left.
    expect(liftable).toHaveLength(7);
    for (const disc of RIM_MIDDLES) expect(liftable).toContain(disc);
    expect(liftable).toContain(key(-2, 0));
    expect(liftable).not.toContain(key(0, -2)); // black pawn still on it
  });

  it('never leaves a disc on offer that could not be slid out', () => {
    const game = createGame();
    const moved = movePawn(game, { kind: 'pawn', from: key(-2, 0), to: key(1, 0) });
    for (const cell of INITIAL_CELLS) {
      const offered = liftableDiscs(moved).includes(cellKey(cell));
      // The whole rim is offered, the seven locked middle discs never are.
      expect(offered, `${cell.q},${cell.r}`).toBe(
        canSlideOut(boardOf(field), cell) && !moved.pawns.has(cellKey(cell)),
      );
    }
  });

  it('never offers a disc with a pawn on it', () => {
    const game = createGame();
    const moved = movePawn(game, { kind: 'pawn', from: key(-2, 0), to: key(1, 0) });
    for (const disc of liftableDiscs(moved)) expect(moved.pawns.has(disc)).toBe(false);
  });

  it('opens up a disc that used to be walled in', () => {
    const game = createGame();
    const moved = movePawn(game, { kind: 'pawn', from: key(-2, 0), to: key(1, 0) });
    // (1,0) sits in the middle with all six neighbours; nothing frees it yet.
    expect(liftableDiscs(moved)).not.toContain(key(1, 0));

    // Clear the two discs to its east. One empty neighbour is not enough --
    // the disc still has five neighbours and no way through.
    const once: GameState = {
      ...moved,
      discs: new Set([...moved.discs].filter((c) => c !== key(2, 0))),
    };
    expect(canSlideOut(once.discs, { q: 1, r: 0 })).toBe(false);

    // Two in a row and there is a 180 degree gap to slide out through.
    const opened: GameState = {
      ...moved,
      discs: new Set([...moved.discs].filter((c) => c !== key(2, 0) && c !== key(2, -1))),
    };
    expect(canSlideOut(opened.discs, { q: 1, r: 0 })).toBe(true);
  });

  it('holds a disc back from the opponent for one turn only', () => {
    const game = createGame();
    const moved = movePawn(game, { kind: 'pawn', from: key(-2, 0), to: key(1, 0) });
    const lifted = liftDisc(moved, key(2, -1));
    const spot = placementCells(lifted)[0];
    const afterRed = placeDisc(lifted, spot);

    expect(afterRed.lockedDisc).toBe(spot);
    expect(afterRed.turn).toBe('black');

    // Black cannot touch the disc red just put down...
    const blackMoved = movePawn(afterRed, { kind: 'pawn', from: key(0, -2), to: key(1, -2) });
    expect(liftableDiscs(blackMoved)).not.toContain(spot);

    // ...but it is fair game again for red on the following turn.
    const afterBlack = placeAvoiding(liftDisc(blackMoved, liftableDiscs(blackMoved)[0]), spot);
    const redMoved = movePawn(afterBlack, { kind: 'pawn', from: key(0, 2), to: key(1, 1) });
    expect(liftableDiscs(redMoved)).toContain(spot);
  });

  it('lets the player relocate their own disc on a later turn', () => {
    const game = createGame();
    const moved = movePawn(game, { kind: 'pawn', from: key(-2, 0), to: key(1, 0) });
    const lifted = liftDisc(moved, key(2, -1));
    const spot = placementCells(lifted)[0];
    const afterRed = placeDisc(lifted, spot);

    const blackMoved = movePawn(afterRed, { kind: 'pawn', from: key(0, -2), to: key(1, -2) });
    const blackLifted = liftDisc(blackMoved, liftableDiscs(blackMoved)[0]);
    const afterBlack = placeDisc(blackLifted, placementCells(blackLifted)[0]);

    // Red's turn: their own disc from last round is unlocked again, while the
    // disc black just moved is not.
    const redMoved = movePawn(afterBlack, { kind: 'pawn', from: key(0, 2), to: key(1, 1) });
    expect(liftableDiscs(redMoved)).toContain(spot);
    expect(liftableDiscs(redMoved)).not.toContain(afterBlack.lockedDisc);
  });

  it('requires the new spot to touch at least two discs', () => {
    const game = createGame();
    const moved = movePawn(game, { kind: 'pawn', from: key(-2, 0), to: key(1, 0) });
    const lifted = liftDisc(moved, key(2, -1));
    const spots = placementCells(lifted);
    expect(spots.length).toBeGreaterThan(0);
    for (const spot of spots) {
      const touching = neighbours(parseKey(spot)).filter((n) => lifted.discs.has(cellKey(n)));
      expect(touching.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('rejects a spot that touches only one disc', () => {
    // A row of three discs with the fourth one held above its end.
    const held = key(3, 0);
    const row: GameState = {
      ...position(
        [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
        [
          [[-1, 2], 'red'],
          [[-2, 2], 'red'],
          [[-2, 0], 'black'],
        ],
      ),
      phase: 'move-disc',
      heldDisc: held,
    };

    // Back where it came from it would touch a single disc, so that is refused...
    expect(placementCells(row)).not.toContain(held);
    // ...while the notch above the row, touching two discs, is offered.
    expect(placementCells(row)).toContain(key(1, 1));
    expect(() => placeDisc(row, held)).toThrow(/at least two/);
  });

  it('will not leave a disc exactly where it was lifted', () => {
    const game = createGame();
    const moved = movePawn(game, { kind: 'pawn', from: key(-2, 0), to: key(1, 0) });
    const from = key(2, -1);
    // The rulebook relocates the disc to *another* position.
    expect(placementCells(liftDisc(moved, from))).not.toContain(from);
    // Even though putting it back would touch three discs.
    expect(moved.discs.has(from)).toBe(true);
  });

  it('still lets a tip disc go home when nothing else would hold it', () => {
    // Only one disc left on the table: nowhere rests against two, so the disc
    // in hand has to go back where it came from.
    const tip: GameState = {
      ...position(
        [[0, 0]],
        [[[-1, 2], 'red']],
      ),
      phase: 'move-disc',
      heldDisc: key(1, 0),
    };
    expect(placementCells(tip)).toEqual([key(1, 0)]);
    expect(placeDisc(tip, key(1, 0)).discs.size).toBe(2);
  });

  it('refuses to pick up a walled-in disc', () => {
    const game = createGame();
    const walled = INITIAL_CELLS.find(({ q, r }) => isWalledIn(q, r))!;
    const moved = movePawn(game, { kind: 'pawn', from: key(-2, 0), to: key(1, 0) });
    expect(() => liftDisc(moved, cellKey(walled))).toThrow(/cannot be moved/);
  });

  it('refuses to pick up a disc with a pawn on it', () => {
    const game = createGame();
    const moved = movePawn(game, { kind: 'pawn', from: key(-2, 0), to: key(1, 0) });
    expect(() => liftDisc(moved, key(2, -2))).toThrow(/cannot be moved/);
  });

  it('refuses a disc move before a pawn has been slid', () => {
    const game = createGame();
    expect(liftableDiscs(game)).toHaveLength(0);
    expect(() => liftDisc(game, key(2, -1))).toThrow();
  });

  it('refuses a second disc in the same turn', () => {
    const game = createGame();
    const moved = movePawn(game, { kind: 'pawn', from: key(-2, 0), to: key(1, 0) });
    const lifted = liftDisc(moved, key(2, -1));
    expect(() => liftDisc(lifted, key(1, -2))).toThrow();
  });

  it('refuses to put a second disc down', () => {
    const game = createGame();
    const moved = movePawn(game, { kind: 'pawn', from: key(-2, 0), to: key(1, 0) });
    const lifted = liftDisc(moved, key(2, -1));
    const done = placeDisc(lifted, placementCells(lifted)[0]);
    expect(() => placeDisc(done, key(1, 2))).toThrow(/No disc is being held/);
  });
});

describe('a whole turn', () => {
  it('ends with 19 discs, 6 pawns and the other player to move', () => {
    const game = createGame({ firstPlayer: 'red' });
    const afterPawn = movePawn(game, { kind: 'pawn', from: key(2, -2), to: key(-1, 1) });
    expect(afterPawn.phase).toBe('move-disc');
    expect(afterPawn.turn).toBe('red');

    const lifted = liftDisc(afterPawn, key(2, -1));
    const spot = placementCells(lifted)[0];
    const afterDisc = placeDisc(lifted, spot);

    expect(afterDisc.discs.size).toBe(19);
    expect(afterDisc.pawns.size).toBe(6);
    expect(afterDisc.discs.has(key(2, -1))).toBe(false);
    expect(afterDisc.discs.has(spot)).toBe(true);
    expect(afterDisc.turn).toBe('black');
    expect(afterDisc.phase).toBe('move-pawn');
    expect(afterDisc.turnNumber).toBe(2);
    expect(afterDisc.lockedDisc).toBe(spot);
  });

  it('moves the pawn off its old cell and onto the new one', () => {
    const game = createGame();
    const moved = movePawn(game, { kind: 'pawn', from: key(2, -2), to: key(2, -1) });
    expect(moved.pawns.has(key(2, -2))).toBe(false);
    expect(moved.pawns.get(key(2, -1))).toBe('red');
  });

  it('always leaves black a disc to move', () => {
    const game = createGame();
    for (const move of legalPawnMoves(game)) {
      const next = movePawn(game, move);
      if (next.phase === 'game-over') continue;
      const liftable = liftableDiscs(next);
      expect(liftable.length).toBeGreaterThan(0);
      expect(placementCells(liftDisc(next, liftable[0])).length).toBeGreaterThan(0);
    }
  });

  it('plays random games to a finish without ever getting stuck', () => {
    let longest = 0;
    let draws = 0;

    for (let game = 0; game < 25; game++) {
      const session = new Session('red');
      let steps = 0;

      while (!session.over && steps < 4000) {
        const moves = legalMoves(session.state);
        expect(moves.length, `no legal move on turn ${session.state.turnNumber}`).toBeGreaterThan(0);
        const move = moves[Math.floor(Math.random() * moves.length)];
        if (move.kind === 'pawn') session.movePawn(move);
        else if (session.state.heldDisc === null) session.liftDisc(move.from);
        else session.placeDisc(move);
        steps++;
      }

      expect(session.over, 'game did not finish').toBe(true);
      longest = Math.max(longest, session.state.turnNumber);

      // Whatever happened, the board is left in a legal shape: every pawn is
      // still standing on a disc and all nineteen discs are accounted for.
      // (A disc left touching on one side only is explicitly allowed.)
      const { state } = session;
      expect(state.discs.size).toBe(19);
      expect(state.pawns.size).toBe(6);
      for (const pawn of state.pawns.keys()) expect(state.discs.has(pawn)).toBe(true);

      // A game that ends without a winner must say why.
      if (state.winner === null) {
        draws++;
        expect(session.drawReason).not.toBeNull();
      } else {
        expect(session.drawReason).toBeNull();
      }

      // The log holds every turn that was played, in order and none twice.
      expect(session.moves.map((entry) => entry.turn)).toEqual(
        session.moves.map((_, index) => index + 1),
      );
    }

    // Random play mostly finishes briskly. A game that gets nowhere is drawn by
    // the turn limit, which can overshoot by a turn or two when settling passes
    // a player straight over the line.
    expect(longest).toBeLessThanOrEqual(TURN_LIMIT + 2);
    expect(draws).toBeGreaterThan(0);
  });

  it('undoes a turn step by step and keeps the log in step', () => {
    const session = new Session('red');
    const opening = session.state;
    const [move] = legalPawnMoves(opening);

    session.movePawn(move);
    const liftable = liftableDiscs(session.state);
    session.liftDisc(liftable[0]);
    const [spot] = placementCells(session.state);
    session.placeDisc({ kind: 'disc', from: liftable[0], to: spot });

    expect(session.moves).toHaveLength(1);
    expect(session.state.turnNumber).toBe(2);
    expect(session.canUndo).toBe(true);

    session.undo(); // take the disc back
    expect(session.state.heldDisc).not.toBeNull();
    session.undo(); // put the disc back on the table
    expect(session.state.heldDisc).toBeNull();
    session.undo(); // un-slide the pawn
    expect(session.state).toEqual(opening);
    expect(session.moves).toHaveLength(0);
    expect(session.canUndo).toBe(false);
    expect(session.undo()).toBe(false);
  });

  it('fingerprints a position without counting the turn number', () => {
    const game = createGame();
    const later: GameState = { ...game, turnNumber: 99 };
    expect(positionSignature(game)).toBe(positionSignature(later));

    // The locked disc changes what is legal, so it is part of the fingerprint.
    const locked: GameState = { ...game, lockedDisc: key(0, 0) };
    expect(positionSignature(game)).not.toBe(positionSignature(locked));
  });
});

describe('a walled-in player', () => {
  /** Three red pawns boxed in on every side; black is out of the way. */
  const trapped: GameState = {
    discs: new Set([
      key(-1, -2),
      key(-1, -1),
      key(0, -3),
      key(0, -2),
      key(1, -2),
      key(0, 0),
      key(0, 1),
      key(-1, 1),
    ]),
    pawns: new Map([
      [key(-1, -2), 'red'],
      [key(0, -2), 'red'],
      [key(1, -2), 'red'],
      [key(-1, -1), 'black'],
      [key(0, -3), 'black'],
      [key(-1, 1), 'black'],
    ]),
    turn: 'red',
    phase: 'move-pawn',
    lockedDisc: null,
    heldDisc: null,
    winner: null,
    turnNumber: 1,
  };

  it('really has nowhere to slide a pawn', () => {
    expect(legalPawnMoves(trapped)).toHaveLength(0);
  });

  it('still gets to move a disc, which can free the pawns up', () => {
    const next = settle(trapped);
    expect(next.phase).toBe('move-disc');
    expect(next.turn).toBe('red');
    expect(liftableDiscs(next).length).toBeGreaterThan(0);

    // A new disc can bridge the gap and set the pawns moving again.
    const lifted = liftDisc(next, liftableDiscs(next)[0]);
    expect(placementCells(lifted).length).toBeGreaterThan(0);
  });

  it('is drawn when not a single step is possible', () => {
    const hopeless: GameState = {
      ...trapped,
      discs: new Set([key(0, 0), key(0, 1), key(-1, 1)]),
      pawns: new Map([
        [key(0, 0), 'red'],
        [key(-1, 1), 'red'],
        [key(0, 1), 'red'],
      ]),
    };
    expect(legalPawnMoves(hopeless)).toHaveLength(0);
    expect(settle(hopeless).phase).toBe('game-over');
    expect(settle(hopeless).winner).toBeNull();
  });

  it('leaves an ordinary position alone', () => {
    const game = createGame();
    expect(settle(game)).toBe(game);
  });
});
