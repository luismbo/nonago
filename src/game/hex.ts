/**
 * Hex geometry for the Nonaga board.
 *
 * Cells use axial coordinates on a pointy-top grid, which lays the starting
 * position out as horizontal rows of 3-4-5-4-3 — exactly like the board in the
 * rulebook. Discs always sit on grid cells, so the whole game can be modelled
 * with integers.
 */

export interface Cell {
  readonly q: number;
  readonly r: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** String id of a cell, so cells can be used as Map/Set keys. */
export type CellKey = string;

export const cellKey = (cell: Cell): CellKey => `${cell.q},${cell.r}`;

export const parseKey = (key: CellKey): Cell => {
  const [q, r] = key.split(',');
  return { q: Number(q), r: Number(r) };
};

/** The six straight-line directions, counter-clockwise on screen. */
export const DIRECTIONS: readonly Cell[] = [
  { q: 1, r: 0 }, // east
  { q: 1, r: -1 }, // north-east
  { q: 0, r: -1 }, // north-west
  { q: -1, r: 0 }, // west
  { q: -1, r: 1 }, // south-west
  { q: 0, r: 1 }, // south-east
];

export const add = (a: Cell, b: Cell): Cell => ({ q: a.q + b.q, r: a.r + b.r });

export const neighbours = (cell: Cell): Cell[] => DIRECTIONS.map((d) => add(cell, d));

export const hexDistance = (a: Cell, b: Cell): number => {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
};

export const areAdjacent = (a: Cell, b: Cell): boolean => hexDistance(a, b) === 1;

/** Radius of the starting hexagon: 1 + 6 + 12 = 19 discs. */
export const BOARD_RADIUS = 2;

/** The 19 cells of the starting hexagon. */
export const INITIAL_CELLS: readonly Cell[] = (() => {
  const cells: Cell[] = [];
  for (let q = -BOARD_RADIUS; q <= BOARD_RADIUS; q++) {
    for (let r = -BOARD_RADIUS; r <= BOARD_RADIUS; r++) {
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= BOARD_RADIUS) {
        cells.push({ q, r });
      }
    }
  }
  return cells;
})();

/**
 * The six corner discs, clockwise starting at the top-left corner. This is the
 * order the rulebook uses, where pawns alternate black / red around the board.
 */
export const CORNER_CELLS: readonly Cell[] = [
  { q: 0, r: -2 }, // top-left
  { q: 2, r: -2 }, // top-right
  { q: 2, r: 0 }, // right
  { q: 0, r: 2 }, // bottom-right
  { q: -2, r: 2 }, // bottom-left
  { q: -2, r: 0 }, // left
];

/** Centre of a cell in SVG user units, for a disc of the given radius. */
export const toPixel = (cell: Cell, radius = 1): Point => ({
  x: Math.sqrt(3) * radius * (cell.q + cell.r / 2),
  y: 1.5 * radius * cell.r,
});
