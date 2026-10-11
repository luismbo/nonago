/**
 * Wiring between the rules and the page: it owns the session, turns clicks
 * into legal moves, and keeps the status line, scoreboard and move log in step.
 */

import './style.css';

import { type CellKey, cellKey } from './game/hex';
import { legalPawnMoves, liftableDiscs, placementCells, type Player } from './game/rules';
import { type DrawReason, Session } from './game/session';
import { Board, type BoardModel } from './ui/board';

const dom = {
  status: document.getElementById('status')!,
  log: document.getElementById('log')!,
  undo: document.getElementById('undo') as HTMLButtonElement,
  newGame: document.getElementById('new-game') as HTMLButtonElement,
  rules: document.getElementById('rules') as HTMLButtonElement,
  rulesDialog: document.getElementById('rules-dialog') as HTMLDialogElement,
  red: document.getElementById('player-red')!,
  black: document.getElementById('player-black')!,
};

const name = (player: Player): string => (player === 'red' ? 'Red' : 'Black');

/** What the player is in the middle of doing, on top of the rules' own phase. */
type Selection = { kind: 'pawn'; cell: CellKey } | { kind: 'disc' } | null;

class Game {
  private session = new Session(this.pickStarter());
  private selection: Selection = null;
  private hover: CellKey | null = null;
  private slide: { from: CellKey; to: CellKey } | null = null;

  private readonly board = new Board(document.getElementById('board') as unknown as SVGSVGElement, (cell) =>
    this.onCellClick(cell),
  );

  start(): void {
    dom.newGame.addEventListener('click', () => this.reset());
    dom.undo.addEventListener('click', () => this.undo());
    dom.rules.addEventListener('click', () => dom.rulesDialog.showModal());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !dom.rulesDialog.open) this.cancel();
    });
    this.render();
  }

  /** The rulebook has the opening move settled at random. */
  private pickStarter(): Player {
    return Math.random() < 0.5 ? 'red' : 'black';
  }

  private reset(): void {
    this.session = new Session(this.pickStarter());
    this.selection = null;
    this.slide = null;
    this.render();
  }

  private undo(): void {
    if (!this.session.undo()) return;
    this.selection = null;
    this.slide = null;
    this.render();
  }

  private cancel(): void {
    if (this.selection?.kind === 'pawn') {
      this.selection = null;
    } else if (this.session.state.heldDisc !== null) {
      this.undo();
    }
    this.render();
  }

  private onCellClick(cell: CellKey): void {
    const state = this.session.state;
    if (state.phase === 'game-over') return;

    if (state.phase === 'move-pawn') {
      const selected = this.selection?.kind === 'pawn' ? this.selection.cell : null;
      // A click on one of the highlighted landing spots plays the slide...
      const slide = selected ? this.slidesFrom(selected).find((move) => move.to === cell) : undefined;
      if (selected && slide) {
        this.playSlide(selected, cell);
        return;
      }
      // ...otherwise it picks a pawn, or puts the choice back. A pawn with
      // nowhere to go cannot be picked at all.
      if (state.pawns.has(cell) && state.pawns.get(cell) === state.turn && this.slidesFrom(cell).length > 0) {
        this.selection = selected === cell ? null : { kind: 'pawn', cell };
      } else {
        this.selection = null;
      }
      this.render();
      return;
    }

    if (state.heldDisc === null) {
      if (liftableDiscs(state).includes(cell)) {
        this.session.liftDisc(cell);
      }
      this.render();
      return;
    }

    if (placementCells(state).includes(cell)) {
      this.session.placeDisc({ kind: 'disc', from: state.heldDisc, to: cell });
    }
    this.render();
  }

  private slidesFrom(cell: CellKey) {
    const state = this.session.state;
    if (state.pawns.get(cell) !== state.turn) return [];
    return legalPawnMoves(state).filter((move) => move.from === cell);
  }

  private playSlide(from: CellKey, to: CellKey): void {
    this.slide = { from, to };
    this.selection = null;
    this.session.movePawn({ kind: 'pawn', from, to });
    this.render();
  }

  private model(): BoardModel {
    const state = this.session.state;
    const selected = this.selection?.kind === 'pawn' ? this.selection.cell : null;
    return {
      state,
      selected,
      slides: selected ? this.slidesFrom(selected) : [],
      liftable: new Set(state.heldDisc === null ? liftableDiscs(state) : []),
      placements: new Set(state.heldDisc === null ? [] : placementCells(state)),
      hover: this.hover,
      slide: this.slide,
    };
  }

  private render(): void {
    const model = this.model();
    this.board.render(model);
    this.slide = null;
    this.renderStatus(model);
    this.renderScoreboard(model);
    this.renderLog();
    dom.undo.disabled = !this.session.canUndo;
  }

  private renderStatus(model: BoardModel): void {
    const { state } = model;
    const who = name(state.turn);

    if (state.phase === 'game-over') {
      const reason = this.session.drawReason;
      const outcome = state.winner
        ? `${name(state.winner)} wins!`
        : reason === 'repetition'
          ? 'Drawn — the same position kept coming round'
          : reason === 'turn-limit'
            ? 'Drawn — the game ran long without anyone getting together'
            : 'Drawn — nobody had a move left';
      dom.status.innerHTML = `<strong class="${state.winner ? `is-${state.winner}` : ''}">${outcome}</strong>`;
      dom.status.dataset.phase = 'over';
      return;
    }

    const hint =
      state.phase === 'move-pawn'
        ? model.selected
          ? `choose where the ${who.toLowerCase()} pawn slides to`
          : 'choose one of your pawns'
        : state.heldDisc === null
          ? 'now lift a disc from the edge of the field'
          : 'now put the disc down where it touches two others';

    dom.status.innerHTML = `<span class="pip pip--${state.turn}"></span> <strong class="is-${state.turn}">${who}</strong> — ${hint}`;
    dom.status.dataset.phase = state.phase;
  }

  private renderScoreboard(model: BoardModel): void {
    const { state } = model;
    for (const player of ['red', 'black'] as const) {
      const node = player === 'red' ? dom.red : dom.black;
      const note = node.querySelector('.player__note')!;
      if (state.winner === player) note.textContent = 'winner';
      else if (state.phase === 'game-over') note.textContent = '';
      else note.textContent = state.turn === player ? 'to move' : '';
      node.classList.toggle('is-active', state.turn === player && state.phase !== 'game-over');
      node.classList.toggle('is-winner', state.winner === player);
    }
  }

  private renderLog(): void {
    const entries = this.session.moves;
    dom.log.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'log__empty';
      empty.textContent = 'No moves yet.';
      dom.log.append(empty);
      return;
    }

    for (const entry of entries.slice(-40)) {
      const item = document.createElement('li');
      const disc = entry.disc ? `${entry.disc.from} → ${entry.disc.to}` : '—';
      item.innerHTML =
        `<span class="pip pip--${entry.player}"></span>` +
        `<span class="log__turn">${entry.turn}</span>` +
        `<span class="log__pawn">${entry.pawn ? `${entry.pawn.from} → ${entry.pawn.to}` : 'no move'}</span>` +
        `<span class="log__disc">${disc}</span>`;
      dom.log.append(item);
    }
    dom.log.scrollTop = dom.log.scrollHeight;
  }
}

new Game().start();

export type { DrawReason };
export { cellKey };
