/**
 * The board: a single SVG that is reconciled in place rather than redrawn, so
 * that a pawn keeps its element — and therefore its CSS transition — as it
 * slides from one end of the board to the other.
 */

import {
  type Cell,
  type CellKey,
  INITIAL_CELLS,
  cellKey,
  parseKey,
  toPixel,
} from '../game/hex';
import type { GameState, PawnMove } from '../game/rules';

const NS = 'http://www.w3.org/2000/svg';

/** Everything on the board is drawn in units of one disc radius. */
const R = 1;
const VIEW_PAD = 0.6;

export interface BoardModel {
  readonly state: GameState;
  /** Pawn the player has picked up, waiting for a destination. */
  readonly selected: CellKey | null;
  /** Slides available from the selected pawn. */
  readonly slides: readonly PawnMove[];
  readonly liftable: ReadonlySet<CellKey>;
  readonly placements: ReadonlySet<CellKey>;
  readonly hover: CellKey | null;
  /** Set for one render after a pawn slides, to trigger the animation. */
  readonly slide?: { readonly from: CellKey; readonly to: CellKey } | null;
}

type ClickHandler = (cell: CellKey) => void;

const el = <K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

/** The pawn silhouette, in units of the disc radius it stands on. */
const PAWN_PATH =
  'M -0.46 0.40 L -0.30 0.12 L -0.30 -0.32 C -0.30 -0.53 -0.17 -0.65 0 -0.65 ' +
  'C 0.17 -0.65 0.30 -0.53 0.30 -0.32 L 0.30 0.12 L 0.46 0.40 Z';

export class Board {
  private readonly svg: SVGSVGElement;
  private readonly discs = new Map<CellKey, SVGGElement>();
  private readonly pawns = new Map<CellKey, SVGGElement>();
  private readonly hit = new Map<CellKey, SVGCircleElement>();
  private readonly hints = el('g', { class: 'layer-hints' });
  private readonly hits = el('g', { class: 'layer-hits' });
  private readonly arrows = el('g', { class: 'layer-arrows' });
  private readonly pawnLayer = el('g', { class: 'layer-pawns' });
  private readonly discLayer = el('g', { class: 'layer-discs' });
  private readonly labelLayer = el('g', { class: 'layer-labels' });

  constructor(svg: SVGSVGElement, private readonly onClick: ClickHandler) {
    this.svg = svg;
    svg.replaceChildren(
      this.defs(),
      this.discLayer,
      this.hints,
      this.pawnLayer,
      this.hits,
      this.arrows,
      this.labelLayer,
    );
    svg.addEventListener('click', (event) => {
      const target = (event.target as Element).closest('[data-cell]');
      if (target) this.onClick(target.getAttribute('data-cell')!);
    });
  }

  private defs(): SVGDefsElement {
    const defs = el('defs');

    const wood = el('radialGradient', { id: 'wood', cx: '38%', cy: '32%', r: '78%' });
    wood.append(
      el('stop', { offset: '0', 'stop-color': '#f6e3c2' }),
      el('stop', { offset: '0.55', 'stop-color': '#e3c79b' }),
      el('stop', { offset: '1', 'stop-color': '#bd9763' }),
    );

    const red = el('linearGradient', { id: 'pawn-red', x1: '0', y1: '0', x2: '0', y2: '1' });
    red.append(
      el('stop', { offset: '0', 'stop-color': '#ef6a5c' }),
      el('stop', { offset: '1', 'stop-color': '#a8241c' }),
    );

    const black = el('linearGradient', { id: 'pawn-black', x1: '0', y1: '0', x2: '0', y2: '1' });
    black.append(
      el('stop', { offset: '0', 'stop-color': '#5c5f68' }),
      el('stop', { offset: '1', 'stop-color': '#1b1c21' }),
    );

    // An empty spot where the lifted disc would land: the wood colour, ghosted.
    const ghost = el('radialGradient', { id: 'ghost', cx: '38%', cy: '32%', r: '78%' });
    ghost.append(
      el('stop', { offset: '0', 'stop-color': '#ffeccb', 'stop-opacity': '0.72' }),
      el('stop', { offset: '1', 'stop-color': '#d8ab6d', 'stop-opacity': '0.34' }),
    );

    const arrow = el('marker', {
      id: 'arrowhead',
      viewBox: '0 0 10 10',
      refX: '7.5',
      refY: '5',
      markerWidth: '5',
      markerHeight: '5',
      orient: 'auto-start-reverse',
    });
    arrow.append(el('path', { d: 'M 0 0 L 10 5 L 0 10 z' }));

    defs.append(wood, red, black, ghost, arrow);
    return defs;
  }

  render(model: BoardModel): void {
    const { state } = model;
    this.fit(state, model);

    this.syncDiscs(state);
    this.syncPawns(state, model);
    this.syncHits(state, model);
    this.syncHints(model);
    this.syncArrows(model);
    this.syncLabels(model);
  }

  /** Keep the whole field in view as it grows and shrinks. */
  private fit(state: GameState, model: BoardModel): void {
    const cells = [...INITIAL_CELLS, ...[...state.discs].map(parseKey), ...this.interesting(state, model)];
    const points = cells.map((cell) => toPixel(cell, R));
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const pad = R + VIEW_PAD;
    const minX = Math.min(...xs) - pad;
    const maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad;
    const maxY = Math.max(...ys) + pad;
    this.svg.setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
  }

  /** Cells that are empty but still matter: targets, liftable discs, drop spots. */
  private interesting(_state: GameState, model: BoardModel): Cell[] {
    const keys: CellKey[] = [
      ...model.slides.map((slide) => slide.to),
      ...model.liftable,
      ...model.placements,
    ];
    if (model.hover) keys.push(model.hover);
    return keys.map(parseKey);
  }

  private syncDiscs(state: GameState): void {
    for (const [key, node] of this.discs) {
      if (state.discs.has(key)) continue;
      node.remove();
      this.discs.delete(key);
    }
    for (const key of state.discs) {
      let node = this.discs.get(key);
      if (!node) {
        node = el('g', { class: 'disc' });
        node.append(
          el('circle', { class: 'disc__shadow', r: R * 0.97 }),
          el('circle', { class: 'disc__face', r: R * 0.9 }),
          el('circle', { class: 'disc__ring', r: R * 0.9 }),
          el('path', { class: 'disc__grain', d: 'M -0.55 0.06 Q 0 0.16 0.55 0.04' }),
        );
        this.discLayer.append(node);
        this.discs.set(key, node);
      }
      this.place(node, key);
    }
  }

  private syncPawns(state: GameState, model: BoardModel): void {
    // Reuse the sliding pawn's element so the CSS transition carries it over.
    if (model.slide) {
      const node = this.pawns.get(model.slide.from);
      if (node) {
        this.pawns.delete(model.slide.from);
        this.pawns.set(model.slide.to, node);
      }
    }

    for (const [key, node] of this.pawns) {
      if (state.pawns.has(key)) continue;
      node.remove();
      this.pawns.delete(key);
    }

    for (const [key, owner] of state.pawns) {
      let node = this.pawns.get(key);
      if (!node) {
        node = el('g', { class: `pawn pawn--${owner}` });
        node.append(
          el('ellipse', { class: 'pawn__shadow', cx: 0, cy: 0.5, rx: 0.56, ry: 0.22 }),
          el('path', { class: 'pawn__body', d: PAWN_PATH }),
          el('ellipse', { class: 'pawn__gloss', cx: -0.09, cy: -0.36, rx: 0.14, ry: 0.2 }),
          el('ellipse', { class: 'pawn__foot', cx: 0, cy: 0.4, rx: 0.46, ry: 0.13 }),
        );
        this.pawnLayer.append(node);
        this.pawns.set(key, node);
      }
      if (model.selected === key) node.classList.add('is-selected');
      else node.classList.remove('is-selected');
      if (model.state.winner && owner === model.state.winner) node.classList.add('is-winner');
      this.place(node, key);
    }
  }

  private syncHits(state: GameState, model: BoardModel): void {
    const wanted = new Set<CellKey>([...state.discs, ...state.pawns.keys()]);
    for (const cell of this.interesting(state, model)) wanted.add(cellKey(cell));

    for (const [key, node] of this.hit) {
      if (wanted.has(key)) continue;
      node.remove();
      this.hit.delete(key);
    }

    const hitLayer = this.hits;
    for (const key of wanted) {
      let node = this.hit.get(key);
      if (!node) {
        node = el('circle', { class: 'hit', r: R * 0.96, 'data-cell': key });
        hitLayer.append(node);
        this.hit.set(key, node);
      }
      const { x, y } = toPixel(parseKey(key), R);
      node.setAttribute('cx', String(x));
      node.setAttribute('cy', String(y));
    }
  }

  private syncHints(model: BoardModel): void {
    this.hints.replaceChildren();

    if (model.state.phase === 'move-disc' && model.state.heldDisc === null) {
      for (const key of model.liftable) {
        this.hints.append(el('circle', { class: 'hint hint--lift', r: R * 0.96, ...xy(parseKey(key)) }));
      }
    }

    if (model.state.heldDisc !== null) {
      const { x, y } = toPixel(parseKey(model.state.heldDisc), R);
      this.hints.append(el('circle', { class: 'hole', r: R * 0.9, cx: x, cy: y }));
      for (const key of model.placements) {
        this.hints.append(
          el('circle', {
            class: `hint hint--place${model.hover === key ? ' is-hovered' : ''}`,
            r: R * 0.88,
            ...xy(parseKey(key)),
          }),
        );
      }
    }

    for (const slide of model.slides) {
      this.hints.append(
        el('circle', {
          class: `hint hint--target${model.hover === slide.to ? ' is-hovered' : ''}`,
          r: R * 0.62,
          ...xy(parseKey(slide.to)),
        }),
      );
    }
  }

  private syncArrows(model: BoardModel): void {
    this.arrows.replaceChildren();
    if (!model.selected) return;
    const from = toPixel(parseKey(model.selected), R);
    for (const slide of model.slides) {
      const to = toPixel(parseKey(slide.to), R);
      // Stop short of the target so the arrowhead sits on the marker.
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy) || 1;
      const trim = R * 0.72;
      const end = { x: to.x - (dx / length) * trim, y: to.y - (dy / length) * trim };
      const line = el('line', {
        class: 'arrow',
        x1: from.x + (dx / length) * (R * 0.6),
        y1: from.y + (dy / length) * (R * 0.6),
        x2: end.x,
        y2: end.y,
        'marker-end': 'url(#arrowhead)',
      });
      this.arrows.append(line);
    }
  }

  private syncLabels(model: BoardModel): void {
    this.labelLayer.replaceChildren();
    const key = model.hover;
    if (!key || !model.state.discs.has(key)) return;
    const { x, y } = toPixel(parseKey(key), R);
    const text = el('text', {
      class: 'cell-label',
      x,
      y: y - R * 0.42,
      'text-anchor': 'middle',
    });
    text.textContent = key.replace(',', ' · ');
    this.labelLayer.append(text);
  }

  private place(node: SVGGElement, key: CellKey): void {
    const { x, y } = toPixel(parseKey(key), R);
    node.setAttribute('transform', `translate(${x} ${y})`);
  }
}

const xy = (cell: { q: number; r: number }) => {
  const { x, y } = toPixel(cell, R);
  return { cx: x, cy: y };
};
