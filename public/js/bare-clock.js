/* global TopThai */
/**
 * Bare clock board. Read-only: no control of any kind is rendered here, exactly
 * like /display. The countdown is recomputed from the server's `endsAt` on every
 * frame, never decremented locally.
 *
 * The one thing this page does that /display does not is size itself: the
 * operator decides how many clocks exist, so the grid shape and the digit size
 * are measured rather than fixed.
 */
(function () {
  var board = document.getElementById('board');
  var connEl = document.getElementById('conn');
  var syncEl = document.getElementById('sync');
  var clockEl = document.getElementById('clock');

  var cards = {};
  var laidOutSignature = '';
  var state = null;

  /** Advance width of one tabular digit at weight 800, as a fraction of the font size. */
  var DIGIT_EM = 0.66;
  /** Card padding plus its 3px border, both axes. */
  var CARD_PAD_X = 38;
  var CARD_PAD_Y = 30;
  /** The two 4px gaps between name, countdown and pill. */
  var ROW_GAPS = 8;
  var MIN_LABEL = 11;
  var MIN_PILL = 9;
  /**
   * Below this the digits stop being a clock and become a caption, so the board
   * gives up on fitting everything at once and scrolls instead. Reached only on a
   * phone with a lot of clocks; a room screen never gets near it.
   */
  var MIN_CLOCK_SIZE = 30;
  /** Cap in scroll mode, where there is no height to fill. */
  var MAX_SCROLL_SIZE = 110;

  function buildCard(clock) {
    var el = document.createElement('article');
    el.className = 'bclock';
    el.innerHTML =
      '<div class="bclock__name"></div>' +
      '<div class="bclock__count count">--:--</div>' +
      '<div class="bclock__foot"><span class="status-pill status-ready"></span></div>';

    var refs = {
      root: el,
      name: el.querySelector('.bclock__name'),
      count: el.querySelector('.bclock__count'),
      status: el.querySelector('.status-pill'),
    };
    refs.name.textContent = clock.label;
    cards[clock.id] = refs;
    return el;
  }

  function showEmpty() {
    board.innerHTML = '';
    board.style.setProperty('--cols', 1);
    board.style.setProperty('--rows', 1);
    var note = document.createElement('p');
    note.className = 'bare-empty';
    note.textContent = 'No clocks on the board yet. Add one from the control page.';
    board.appendChild(note);
  }

  function labelSizeFor(size) { return Math.max(MIN_LABEL, Math.round(size * 0.26)); }
  function pillSizeFor(size) { return Math.max(MIN_PILL, Math.round(size * 0.13)); }

  /** Height a card needs for a given digit size: name, countdown, pill, padding. */
  function cardHeightFor(size) {
    return (
      size * 1.02 + labelSizeFor(size) * 1.15 + pillSizeFor(size) * 1.9 + ROW_GAPS + CARD_PAD_Y
    );
  }

  /**
   * Largest digit size that fits a cell in both directions.
   *
   * Width is a straight division; height is walked down one pixel at a time
   * because the name and pill sizes are derived from the digit size and have
   * floors, which makes the relation piecewise. A few hundred cheap iterations on
   * a relayout is not worth solving in closed form and getting subtly wrong -
   * digits that overflow their card are the one failure that matters here.
   */
  function sizeForCell(cellW, cellH, chars) {
    var size = Math.floor((cellW - CARD_PAD_X) / (chars * DIGIT_EM));
    if (cellH === Infinity) return size;
    while (size > 8 && cardHeightFor(size) > cellH) size -= 1;
    return size;
  }

  /** Widest countdown this board can show, so ticking never overflows a card. */
  function widestCountdown() {
    var chars = 4;
    state.clocks.forEach(function (clock) {
      var text = TopThai.formatMMSS(clock.durationSeconds);
      if (text.length > chars) chars = text.length;
    });
    return chars;
  }

  /**
   * Chooses the column count and digit size that fill the board best.
   *
   * Tries every possible number of columns and keeps whichever produces the
   * largest countdown that still fits its cell. Brute force over at most 24
   * options costs nothing and beats a formula, because the winner depends on the
   * viewport aspect ratio as well as the count.
   *
   * When even the best arrangement leaves the digits too small to read - a phone
   * holding a dozen clocks - the board stops trying to fit one screen and scrolls
   * with readable cards instead.
   */
  function fitBoard() {
    if (!state || state.clocks.length === 0) return;

    var count = state.clocks.length;
    var gap = board.clientWidth < 700 ? 10 : 18;
    var width = board.clientWidth - gap * 2;
    var height = board.clientHeight - gap * 2;
    if (width <= 0 || height <= 0) return;

    var chars = widestCountdown();

    var best = null;
    for (var cols = 1; cols <= count; cols += 1) {
      var rows = Math.ceil(count / cols);
      var cellW = (width - gap * (cols - 1)) / cols;
      var cellH = (height - gap * (rows - 1)) / rows;
      if (cellW <= 0 || cellH <= 0) continue;
      var size = sizeForCell(cellW, cellH, chars);
      if (!best || size > best.size) best = { cols: cols, rows: rows, size: size };
    }
    if (!best) return;

    var scrolling = best.size < MIN_CLOCK_SIZE;
    if (scrolling) {
      // Columns from the width alone; the rows then run off the bottom and the
      // board scrolls.
      var minCardW = MIN_CLOCK_SIZE * chars * DIGIT_EM + CARD_PAD_X;
      var fitCols = Math.floor((width + gap) / (minCardW + gap));
      best = { cols: Math.max(1, Math.min(count, fitCols)), rows: 0, size: 0 };
      var scrollCellW = (width - gap * (best.cols - 1)) / best.cols;
      best.size = Math.min(MAX_SCROLL_SIZE, sizeForCell(scrollCellW, Infinity, chars));
      board.style.setProperty('--row-height', Math.ceil(cardHeightFor(best.size)) + 'px');
    }
    board.classList.toggle('is-scroll', scrolling);

    board.style.setProperty('--cols', best.cols);
    board.style.setProperty('--rows', best.rows || 1);
    board.style.setProperty('--gap', gap + 'px');
    board.style.setProperty('--clock-size', Math.max(18, best.size) + 'px');
    board.style.setProperty('--label-size', labelSizeFor(best.size) + 'px');
    board.style.setProperty('--pill-size', pillSizeFor(best.size) + 'px');
  }

  // A ResizeObserver rather than only window.resize: the board also changes size
  // when the browser chrome or an on-screen keyboard appears, and a stale fit
  // leaves the digits overflowing their cards.
  if (window.ResizeObserver) new ResizeObserver(fitBoard).observe(board);
  window.addEventListener('resize', fitBoard);

  /** Rebuild only when the SET of clocks or their names change. */
  function signatureOf(next) {
    return next.clocks
      .map(function (c) { return c.id + ':' + c.label + ':' + c.durationSeconds; })
      .join('|');
  }

  TopThai.onState(function (next) {
    state = next;
    var signature = signatureOf(next);
    if (signature !== laidOutSignature) {
      laidOutSignature = signature;
      cards = {};
      if (next.clocks.length === 0) {
        showEmpty();
        return;
      }
      board.innerHTML = '';
      next.clocks.forEach(function (clock) { board.appendChild(buildCard(clock)); });
      fitBoard();
    }
  });

  TopThai.onConnection(function (status) {
    connEl.className = 'conn is-' + status;
    connEl.textContent = status === 'live' ? 'Live' : status === 'connecting' ? 'Reconnecting' : 'Offline';
  });

  TopThai.startRenderLoop(function () {
    clockEl.textContent = TopThai.bangkokTime(true);
    syncEl.textContent = 'synced ' + TopThai.lastSyncLabel();
    if (!state) return;

    state.clocks.forEach(function (clock) {
      var refs = cards[clock.id];
      if (!refs) return;

      var remaining = TopThai.remainingSeconds(clock.timer);
      refs.count.textContent = TopThai.formatMMSS(remaining);

      var classes = 'bclock__count count ' + TopThai.colorClass(remaining, clock.timer.timerStatus);
      if (TopThai.shouldPulse(clock.timer)) classes += ' is-pulsing';
      refs.count.className = classes.trim();

      refs.status.className = 'status-pill status-' + clock.timer.timerStatus;
      refs.status.textContent = clock.timer.statusLabel;
      refs.root.className = 'bclock is-' + clock.timer.timerStatus;
    });
  });

  TopThai.connect({
    stateEvent: 'bare:state',
    statePath: '/api/bare/state',
    query: { view: 'bare' },
  });
})();
