/* global TopThai */
/**
 * Room display. Read-only: no timer or queue controls are rendered at all.
 */
(function () {
  var stage = document.getElementById('stage');
  var gridMain = document.getElementById('grid-main');
  var gridShopee = document.getElementById('grid-shopee');
  var connEl = document.getElementById('conn');
  var syncEl = document.getElementById('sync');
  var clockEl = document.getElementById('clock');
  var dateEl = document.getElementById('event-date');
  var sessionEl = document.getElementById('session-name');
  var nameEl = document.getElementById('event-name');
  var qrUrlEl = document.getElementById('qr-url');
  var chime = document.getElementById('chime');

  var cards = {};
  var announcedTimeup = {};

  /** Scales the fixed 1920x1080 stage to the actual screen. */
  function fitStage() {
    var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.setProperty('--scale', scale);
  }
  window.addEventListener('resize', fitStage);
  fitStage();

  qrUrlEl.textContent = window.location.origin + '/live';

  function buildCard(table) {
    var el = document.createElement('article');
    el.className = 'card';
    el.innerHTML =
      '<header class="card__head">' +
      '<span class="card__name"></span><span class="card__dur"></span>' +
      '</header>' +
      '<div class="card__count count">--:--</div>' +
      '<div class="card__queue">' +
      '<div class="q q--now"><span class="q__label">NOW</span>' +
      '<span class="q__num"></span><span class="q__co"></span></div>' +
      '<div class="q q--next"><span class="q__label">NEXT</span>' +
      '<span class="q__num"></span><span class="q__co"></span></div>' +
      '</div>' +
      '<footer class="card__foot">' +
      '<span class="status-pill status-ready"></span>' +
      '<span class="conn is-live" title="Realtime connection"></span>' +
      '</footer>';

    var refs = {
      root: el,
      name: el.querySelector('.card__name'),
      dur: el.querySelector('.card__dur'),
      count: el.querySelector('.card__count'),
      nowNum: el.querySelector('.q--now .q__num'),
      nowCo: el.querySelector('.q--now .q__co'),
      nowRow: el.querySelector('.q--now'),
      nextNum: el.querySelector('.q--next .q__num'),
      nextCo: el.querySelector('.q--next .q__co'),
      nextRow: el.querySelector('.q--next'),
      status: el.querySelector('.status-pill'),
      conn: el.querySelector('.card__foot .conn'),
    };
    // Per-day short name: reads across a hall, and stays truthful when the
    // vendor at this position changes (Alibaba on day 1, Profreight on day 2).
    refs.name.textContent = table.shortLabel || table.tableCode;
    refs.dur.textContent = table.durationMinutes + ' min';
    if (!table.isActive) el.classList.add('card--closed');
    cards[table.tableCode] = refs;
    return el;
  }

  function renderQueueRow(numEl, coEl, rowEl, appointment, emptyLabel) {
    if (appointment) {
      rowEl.classList.remove('is-empty');
      numEl.textContent = appointment.queueNumber || appointment.scheduledStart;
      coEl.textContent = appointment.companyName;
    } else {
      rowEl.classList.add('is-empty');
      numEl.textContent = emptyLabel;
      coEl.textContent = '';
    }
  }

  /** Identity of the current card set, so a day switch rebuilds it. */
  function tableSignature(state) {
    return state.tables.map(function (t) { return t.tableCode + ':' + t.shortLabel; }).join('|');
  }

  var laidOutSignature = '';

  function layout(state) {
    // Compare the table SET, not its size: both days have ten tables, so a
    // count check would leave day 1's Alibaba cards on screen all through day 2.
    var signature = tableSignature(state);
    if (signature === laidOutSignature) return;
    laidOutSignature = signature;

    var mainTables = state.tables.filter(function (t) { return t.zone === 'main'; });
    var shopeeTables = state.tables.filter(function (t) { return t.zone === 'shopee'; });

    cards = {};
    gridMain.innerHTML = '';
    gridShopee.innerHTML = '';
    mainTables.forEach(function (t) { gridMain.appendChild(buildCard(t)); });
    shopeeTables.forEach(function (t) { gridShopee.appendChild(buildCard(t)); });
  }

  function currentSession(state) {
    var now = TopThai.bangkokTime(false);
    var found = null;
    state.event.sessions.forEach(function (s) {
      if (now >= s.start && now < s.end) found = s.label + ' · ' + s.start + '–' + s.end;
    });
    if (found) return found;
    var upcoming = state.event.sessions.filter(function (s) { return now < s.start; })[0];
    return upcoming ? 'Break · next ' + upcoming.start : 'Outside session hours';
  }

  function playChime(state) {
    if (!state.event.soundEnabled || !chime) return;
    // Short synthesised beep - no asset to load, and silent unless the
    // operator has switched room sound on.
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!window.__audioCtx) window.__audioCtx = new Ctx();
      var ctx = window.__audioCtx;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.95);
    } catch (error) { /* audio is best-effort */ }
  }

  var state = null;
  TopThai.onState(function (next) {
    state = next;
    layout(next);
    nameEl.textContent = next.event.name;
    dateEl.textContent = TopThai.bangkokDate(next.event.activeDate);
  });

  TopThai.onConnection(function (status) {
    connEl.className = 'conn is-' + status;
    connEl.textContent = status === 'live' ? 'Live' : status === 'connecting' ? 'Reconnecting' : 'Offline';
    Object.keys(cards).forEach(function (code) {
      cards[code].conn.className = 'conn is-' + status;
    });
  });

  TopThai.startRenderLoop(function () {
    clockEl.textContent = TopThai.bangkokTime(true);
    syncEl.textContent = 'synced ' + TopThai.lastSyncLabel();
    if (!state) return;

    sessionEl.textContent = currentSession(state);

    state.tables.forEach(function (table) {
      var card = cards[table.tableCode];
      if (!card) return;

      var remaining = TopThai.remainingSeconds(table.timer);
      card.count.textContent = TopThai.formatMMSS(remaining);

      var classes = 'card__count count ' + TopThai.colorClass(remaining, table.timer.timerStatus);
      if (TopThai.shouldPulse(table.timer)) classes += ' is-pulsing';
      card.count.className = classes.trim();

      var label = table.timer.statusLabel;
      card.status.className = 'status-pill status-' + table.timer.timerStatus;
      card.status.textContent = label;

      renderQueueRow(card.nowNum, card.nowCo, card.nowRow, table.current, '—');
      renderQueueRow(card.nextNum, card.nextCo, card.nextRow, table.next, 'No queue');

      var key = table.tableCode + '|' + (table.timer.timeupAt || '');
      if (table.timer.timerStatus === 'timeup' && table.timer.timeupAt && !announcedTimeup[key]) {
        announcedTimeup[key] = true;
        if (TopThai.serverNow() - Date.parse(table.timer.timeupAt) < 5000) playChime(state);
      }
    });
  });

  TopThai.connect();
})();
