/**
 * Wiring between the rules and the page: it owns the session, turns clicks
 * into legal moves, and keeps the status line, scoreboard and move log in step.
 *
 * When playing the computer, the same session is used for both sides — the
 * computer's turn is simply a turn this file plays for it, one step at a time,
 * so undo, the move log and the drawn games all work exactly as they do when
 * two people share the board.
 */

import './style.css';

import { type CellKey } from './game/hex';
import { DIFFICULTIES, DIFFICULTY_ORDER, type DifficultyId } from './game/ai';
import {
  type Player,
  legalPawnMoves,
  liftDisc,
  liftableDiscs,
  placeDisc,
  placementCells,
} from './game/rules';
import { Session } from './game/session';
import { Opponent } from './ai/opponent';
import { Board, type BoardModel } from './ui/board';

const dom = {
  status: document.getElementById('status')!,
  thinking: document.getElementById('thinking')!,
  thinkingText: document.getElementById('thinking-text')!,
  log: document.getElementById('log')!,
  undo: document.getElementById('undo') as HTMLButtonElement,
  newGame: document.getElementById('new-game') as HTMLButtonElement,
  rules: document.getElementById('rules') as HTMLButtonElement,
  rulesDialog: document.getElementById('rules-dialog') as HTMLDialogElement,
  red: document.getElementById('player-red')!,
  black: document.getElementById('player-black')!,
  difficultyBlurb: document.getElementById('difficulty-blurb')!,
  levels: document.querySelector<HTMLElement>('.levels')!,
};

const name = (player: Player): string => (player === 'red' ? 'Red' : 'Black');

/** What the player is in the middle of doing, on top of the rules' own phase. */
type Selection = { kind: 'pawn'; cell: CellKey } | null;

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

class Game {
  private session = new Session(this.pickStarter());
  private selection: Selection = null;
  private slide: { from: CellKey; to: CellKey } | null = null;

  private opponentMode = false;
  private humanColour: Player = 'red';
  private difficulty: DifficultyId = 'club';
  private computerTurn = 0;
  private busy = false;
  private started = false;

  private readonly bot = new Opponent();
  /** Bumped on every reset, so a search that arrives late can be discarded. */
  private generation = 0;

  private readonly board = new Board(
    document.getElementById('board') as unknown as SVGSVGElement,
    (cell) => this.onCellClick(cell),
  );

  start(): void {
    dom.newGame.addEventListener('click', () => this.reset());
    dom.undo.addEventListener('click', () => this.undo());
    dom.rules.addEventListener('click', () => dom.rulesDialog.showModal());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !dom.rulesDialog.open) this.cancel();
    });

    this.buildLevelButtons();
    this.wireSegmented('data-opponent', 'opponent', (value) => {
      this.opponentMode = value === 'computer';
      this.reset();
    });
    this.wireSegmented('data-colour', 'colour', (value) => {
      this.humanColour = value as Player;
      this.reset();
    });

    this.started = true;
    this.render();
  }

  /** The rulebook has the opening move settled at random. */
  private pickStarter(): Player {
    return Math.random() < 0.5 ? 'red' : 'black';
  }

  private get computerPlays(): Player {
    return this.humanColour === 'red' ? 'black' : 'red';
  }

  /**
   * The computer acts only at the start of its own turn.
   *
   * The phase check matters: undo steps back through individual moves, so it can
   * easily land on the computer's turn part-way through — mid-slide, or with a
   * disc already in hand. Those are the player's to finish, and asking the
   * search for a turn there would find nothing and leave the board stuck.
   */
  private get awaitingComputer(): boolean {
    const state = this.session.state;
    return (
      this.opponentMode &&
      !this.busy &&
      state.phase === 'move-pawn' &&
      this.session.state.turn === this.computerPlays
    );
  }

  private reset(): void {
    this.generation++;
    this.computerTurn = 0;
    this.busy = false;
    this.selection = null;
    this.slide = null;
    // Against the computer the player opens, so the first move is never lost to
    // the search having not finished yet.
    this.session = new Session(this.opponentMode ? this.humanColour : this.pickStarter());
    this.render();
  }

  /**
   * Undo. Against the computer this rewinds a whole round rather than one step.
   *
   * A turn is three moves, and stopping halfway through one leaves the game in a
   * state neither side can finish on its own — the computer's disc is lifted but
   * it is not the computer's turn to put it down. Going back to the player's
   * last turn start is the only point where the game is genuinely playable again.
   */
  /**
   * Step back.
   *
   * A turn is three moves, so stopping halfway through one leaves a game nobody
   * can finish — a disc lifted but it is not that side's turn to put it down.
   * Against the computer there is nobody at the table to complete it, so undo
   * rewinds to the start of the player's last turn, which is the nearest point
   * where the game is playable again. Two players can wind back one step at a
   * time, since the next person can simply finish the turn.
   */
  private undo(): void {
    if (this.busy) return;

    if (this.opponentMode) {
      let rewound = false;
      while (this.session.canUndo) {
        this.session.undo();
        rewound = true;
        const state = this.session.state;
        if (state.phase === 'game-over') break;
        if (state.phase === 'move-pawn' && state.turn === this.humanColour) break;
      }
      if (!rewound) return;
    } else if (!this.session.undo()) {
      return;
    }

    this.selection = null;
    this.slide = null;
    this.render();
  }

  private cancel(): void {
    if (this.busy) return;
    if (this.selection?.kind === 'pawn') this.selection = null;
    else if (this.session.state.heldDisc !== null) this.undo();
    this.render();
  }

  private onCellClick(cell: CellKey): void {
    // The board is only the player's at the start of their own turn.
    if (this.busy || !this.playableNow) return;
    const state = this.session.state;
    if (state.phase === 'game-over') return;

    if (state.phase === 'move-pawn') {
      const selected = this.selection?.kind === 'pawn' ? this.selection.cell : null;
      // A click on one of the highlighted landing spots plays the slide...
      const slide = selected
        ? this.slidesFrom(selected).find((move) => move.to === cell)
        : undefined;
      if (selected && slide) {
        this.playSlide(selected, cell);
        return;
      }
      // ...otherwise it picks a pawn, or puts the choice back. A pawn with
      // nowhere to go cannot be picked at all.
      if (
        state.pawns.has(cell) &&
        state.pawns.get(cell) === state.turn &&
        this.slidesFrom(cell).length > 0
      ) {
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
        this.maybeHandOver();
      }
      this.render();
      return;
    }

    if (placementCells(state).includes(cell)) {
      this.session.placeDisc({ kind: 'disc', from: state.heldDisc, to: cell });
      this.maybeHandOver();
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
    this.maybeHandOver();
  }

  /** The player's turn is over; let the computer take it if it is its move. */
  private maybeHandOver(): void {
    if (!this.started || this.busy) return;
    if (this.session.state.phase === 'game-over') return;
    if (!this.awaitingComputer) return;
    void this.runComputer();
  }

  /**
   * Whether the player may act right now.
   *
   * This covers the whole of their turn, not just its first step: a turn is a
   * slide and then a disc, so the phase changes halfway through and the player
   * still owns it. Only the game being over, or it being the computer's turn,
   * takes the board away.
   */
  private get playableNow(): boolean {
    const state = this.session.state;
    if (state.phase === 'game-over') return false;
    if (!this.opponentMode) return true;
    return state.turn === this.humanColour;
  }

  /**
   * Play one turn for the computer: ask the worker for a plan, then perform its
   * three steps with a pause between them so the move can be followed.
   */
  private async runComputer(): Promise<void> {
    this.busy = true;
    this.selection = null;
    const generation = this.generation;
    this.renderThinking(true);
    this.render();

    try {
      const result = await this.bot.think(
        this.session.state,
        this.difficulty,
        () => generation !== this.generation,
      );

      if (!result.ok || generation !== this.generation) {
        this.busy = false;
        this.renderThinking(false);
        this.render();
        return;
      }

      if (result.thinking.forced) this.renderForced();

      const plan = result.plan;
      if (plan.pawn) {
        this.slide = { from: plan.pawn.from, to: plan.pawn.to };
        this.session.movePawn(plan.pawn);
        this.render();
        await wait(360);
      }
      const { lift, place } = plan;
      if (lift && place && this.session.state.phase !== 'game-over') {
        // Re-check every step against the live rules rather than trusting the
        // plan: it was worked out for a position that has since moved on.
        if (liftableDiscs(this.session.state).includes(lift)) {
          this.session.liftDisc(lift);
          this.render();
          await wait(300);
          const held = this.session.state.heldDisc;
          if (held && placementCells(this.session.state).includes(place)) {
            this.session.placeDisc({ kind: 'disc', from: held, to: place });
            this.render();
            await wait(260);
          }
        }
      }

      this.computerTurn++;
    } catch {
      // A failed search must not strand the game; fall back to a legal turn.
      this.playAnyLegalTurn();
      this.renderThinking(false);
    }

    this.busy = false;
    // The banner only comes down when the turn is genuinely over.
    if (this.session.state.phase !== 'game-over') this.renderThinking(false);
    this.render();

    // A search can be overtaken by an undo landing part-way through a turn, or by
    // a new game starting. If it did, the board is now in a state nobody is going
    // to act on, so finish the turn off rather than freezing.
    if (generation !== this.generation) return;
    if (this.computerIsStranded()) this.finishStrandedTurn();
    if (this.awaitingComputer) void this.runComputer();
  }

  /**
   * True when it is the computer's move but the turn has stalled part-way — a
   * disc lifted with nowhere put down, or a pawn that has already slid.
   */
  private computerIsStranded(): boolean {
    if (!this.opponentMode || this.session.state.phase === 'game-over') return false;
    const state = this.session.state;
    if (state.turn !== this.computerPlays) return false;
    return state.phase !== 'move-pawn';
  }

  /** Complete a stalled computer turn with whatever move is legal. */
  private finishStrandedTurn(): void {
    const state = this.session.state;
    if (state.phase === 'move-disc' && state.heldDisc !== null) {
      const to = placementCells(state)[0];
      if (to) this.session.placeDisc({ kind: 'disc', from: state.heldDisc, to: to });
      else this.session.undo();
    }
    this.render();
  }

  /** Last resort if the computer could not decide: play the first legal turn. */
  private playAnyLegalTurn(): void {
    const state = this.session.state;
    const slides = legalPawnMoves(state);
    if (slides.length > 0) {
      const move = slides[0];
      this.session.movePawn(move);
      const liftable = liftableDiscs(this.session.state);
      const from = liftable[0];
      if (from) {
        const held = liftDisc(this.session.state, from);
        const to = placementCells(held)[0];
        if (to) placeDisc(held, to);
      }
    }
  }

  private model(): BoardModel {
    const state = this.session.state;
    // Nothing is clickable unless this is the player's turn to play.
    const watching = this.busy || !this.playableNow;
    const selected = watching ? null : this.selection?.kind === 'pawn' ? this.selection.cell : null;
    return {
      state,
      selected,
      slides: selected ? this.slidesFrom(selected) : [],
      // Nothing is offered while the computer is moving, so a stray click cannot
      // half-play its turn.
      liftable: new Set(watching || state.heldDisc !== null ? [] : liftableDiscs(state)),
      placements: new Set(
        watching || state.heldDisc === null ? [] : placementCells(state),
      ),
      hover: null,
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
    this.renderSetup();
    const playing = this.session.state.phase !== 'game-over';
    dom.undo.disabled = !this.session.canUndo || this.busy;
    dom.newGame.disabled = this.busy;
    void playing;
  }

  private renderStatus(model: BoardModel): void {
    const { state } = model;
    const who = name(state.turn);

    if (state.phase === 'game-over') {
      const reason = this.session.drawReason;
      const beat = this.opponentMode && state.winner
        ? state.winner === this.humanColour
          ? 'You win!'
          : 'The computer wins'
        : state.winner
          ? `${name(state.winner)} wins!`
          : null;
      const outcome = beat
        ? reason === 'blocked' && !state.winner
          ? 'Drawn — nobody had a move left'
          : beat
        : reason === 'repetition'
          ? 'Drawn — the same position kept coming round'
          : reason === 'turn-limit'
            ? 'Drawn — the game ran long without anyone getting together'
            : 'Drawn — nobody had a move left';
      dom.status.innerHTML = `<strong class="${state.winner ? `is-${state.winner}` : ''}">${outcome}</strong>`;
      dom.status.dataset.phase = 'over';
      this.renderThinking(false);
      return;
    }

    if (this.busy || this.awaitingComputer) {
      dom.status.innerHTML = `<span class="pip pip--${state.turn}"></span> <strong class="is-${state.turn}">${name(state.turn)}</strong> — thinking`;
      dom.status.dataset.phase = state.phase;
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

  /**
   * The banner stays up for the whole of the computer's turn — the search and
   * then the three moves — because that is the whole time the board is not the
   * player's. Clearing it the moment a plan arrives would leave the pawns and
   * disc sliding with nothing on screen to say why.
   */
  private renderThinking(show: boolean): void {
    dom.thinking.hidden = !show;
    if (show) {
      const level = DIFFICULTIES[this.difficulty];
      dom.thinkingText.textContent = `${level.label} — thinking…`;
    }
  }

  /** Say so when the search settled the game outright. */
  private renderForced(): void {
    dom.thinkingText.textContent = `${DIFFICULTIES[this.difficulty].label} — found a forced result`;
  }

  private renderScoreboard(model: BoardModel): void {
    const { state } = model;
    for (const player of ['red', 'black'] as const) {
      const node = player === 'red' ? dom.red : dom.black;
      const note = node.querySelector('.player__note')!;
      const isComputer = this.opponentMode && player === this.computerPlays;
      if (state.winner === player) note.textContent = isComputer ? 'computer wins' : 'winner';
      else if (state.phase === 'game-over') note.textContent = '';
      else if (isComputer) note.textContent = state.turn === player ? 'thinking' : '';
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
      const who = this.opponentMode
        ? `<span class="log__who">${entry.player === this.humanColour ? 'you' : 'pc'}</span>`
        : '';
      item.innerHTML =
        `<span class="pip pip--${entry.player}"></span>` +
        who +
        `<span class="log__turn">${entry.turn}</span>` +
        `<span class="log__pawn">${entry.pawn ? `${entry.pawn.from} → ${entry.pawn.to}` : 'no move'}</span>` +
        `<span class="log__disc">${disc}</span>`;
      dom.log.append(item);
    }
    dom.log.scrollTop = dom.log.scrollHeight;
  }

  // --- setup controls ----------------------------------------------------

  private buildLevelButtons(): void {
    for (const id of DIFFICULTY_ORDER) {
      const level = DIFFICULTIES[id];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `level${id === this.difficulty ? ' is-active' : ''}`;
      button.dataset.level = id;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(id === this.difficulty));
      button.innerHTML =
        `<span class="level__bars" aria-hidden="true">` +
        DIFFICULTY_ORDER.map((step) => `<i class="${DIFFICULTY_ORDER.indexOf(step) <= DIFFICULTY_ORDER.indexOf(id) ? 'is-on' : ''}"></i>`).join('') +
        `</span><span class="level__name">${level.label}</span>`;
      button.addEventListener('click', () => {
        this.difficulty = id;
        this.renderSetup();
        if (this.session.state.phase === 'game-over') this.reset();
      });
      dom.levels.append(button);
    }
    this.renderSetup();
  }

  private renderSetup(): void {
    for (const button of document.querySelectorAll<HTMLElement>('[data-opponent]')) {
      const on = (button.dataset.opponent === 'computer') === this.opponentMode;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-checked', String(on));
    }
    for (const button of document.querySelectorAll<HTMLElement>('[data-colour]')) {
      const on = button.dataset.colour === this.humanColour;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-checked', String(on));
    }
    for (const row of document.querySelectorAll<HTMLElement>('[data-when="computer"]')) {
      row.hidden = !this.opponentMode;
    }
    for (const button of dom.levels.querySelectorAll<HTMLElement>('[data-level]')) {
      const on = button.dataset.level === this.difficulty;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-checked', String(on));
    }
    dom.difficultyBlurb.textContent = DIFFICULTIES[this.difficulty].blurb;
  }

  /** Wire a set of mutually exclusive buttons that all share one group. */
  private wireSegmented(attribute: string, key: string, apply: (value: string) => void): void {
    for (const button of document.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
      button.setAttribute('role', 'radio');
      button.addEventListener('click', () => {
        const value = button.dataset[key]!;
        apply(value);
        this.renderSetup();
      });
    }
  }
}

new Game().start();
