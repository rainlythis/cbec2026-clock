/* global TopThai */
/**
 * Public mobile view. Read-only, no login, and silent: no control action and no
 * sound is reachable from this page.
 */
(function () {
  var chipsEl = document.getElementById('chips');
  var tablesEl = document.getElementById('tables');
  var resultsEl = document.getElementById('results');
  var emptyEl = document.getElementById('empty');
  var searchEl = document.getElementById('search');
  var clearEl = document.getElementById('search-clear');
  var connEl = document.getElementById('conn');
  var syncEl = document.getElementById('sync');
  var clockEl = document.getElementById('clock');
  var nameEl = document.getElementById('event-name');
  var dateEl = document.getElementById('event-date');

  var state = null;
  var filter = 'ALL';
  var term = '';
  var cards = {};
  var laidOutSignature = '';
  var chipSignature = '';

  searchEl.addEventListener('input', function () {
    term = searchEl.value.trim().toLowerCase();
    clearEl.hidden = term.length === 0;
    render();
  });
  clearEl.addEventListener('click', function () {
    searchEl.value = '';
    term = '';
    clearEl.hidden = true;
    searchEl.focus();
    render();
  });

  function buildChips(next) {
    var platforms = [];
    next.tables.forEach(function (t) {
      if (platforms.indexOf(t.platform) === -1) platforms.push(t.platform);
    });
    var options = [{ key: 'ALL', label: 'All tables' }].concat(
      platforms.map(function (p) { return { key: 'P:' + p, label: p }; }),
      next.tables.map(function (t) {
        return { key: 'T:' + t.tableCode, label: t.displayLabel || t.tableCode };
      }),
    );

    chipsEl.innerHTML = '';
    options.forEach(function (option) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip' + (filter === option.key ? ' is-active' : '');
      button.textContent = option.label;
      button.addEventListener('click', function () {
        filter = option.key;
        Array.prototype.forEach.call(chipsEl.children, function (c) { c.classList.remove('is-active'); });
        button.classList.add('is-active');
        render();
      });
      chipsEl.appendChild(button);
    });
  }

  function matchesFilter(table) {
    if (filter === 'ALL') return true;
    if (filter.indexOf('P:') === 0) return table.platform === filter.slice(2);
    if (filter.indexOf('T:') === 0) return table.tableCode === filter.slice(2);
    return true;
  }

  function slot(labelText, appointment, emptyText, isNow) {
    var row = document.createElement('div');
    row.className = 'slot' + (isNow ? ' slot--now' : '') + (appointment ? '' : ' is-empty');
    var label = document.createElement('span');
    label.className = 'slot__label';
    label.textContent = labelText;
    var body = document.createElement('div');
    body.className = 'slot__body';
    var num = document.createElement('div');
    num.className = 'slot__num';
    num.textContent = appointment ? (appointment.queueNumber || appointment.scheduledStart) : emptyText;
    body.appendChild(num);
    if (appointment) {
      var co = document.createElement('div');
      co.className = 'slot__co';
      co.textContent = appointment.companyName;
      body.appendChild(co);
    }
    row.appendChild(label);
    row.appendChild(body);
    if (appointment) {
      var time = document.createElement('span');
      time.className = 'slot__time';
      time.textContent = appointment.scheduledStart;
      row.appendChild(time);
    }
    return row;
  }

  function buildCard(table) {
    var el = document.createElement('article');
    el.className = 'tcard' + (table.zone === 'shopee' ? ' tcard--shopee' : '');
    el.innerHTML =
      '<div class="tcard__head">' +
      '<div class="tcard__title"><span class="tcard__name"></span>' +
      '<span class="tcard__dur"></span></div>' +
      '<div class="tcard__right"><span class="tcard__count count">--:--</span>' +
      '<span class="status-pill status-ready"></span></div>' +
      '</div><div class="tcard__slots"></div>' +
      '<div class="upcoming"><p class="upcoming__title">UPCOMING</p><div class="upcoming__list"></div></div>';

    var refs = {
      root: el,
      name: el.querySelector('.tcard__name'),
      dur: el.querySelector('.tcard__dur'),
      count: el.querySelector('.tcard__count'),
      status: el.querySelector('.status-pill'),
      slots: el.querySelector('.tcard__slots'),
      upcoming: el.querySelector('.upcoming__list'),
      upcomingWrap: el.querySelector('.upcoming'),
      signature: '',
    };
    refs.name.textContent = table.displayLabel || table.tableCode;
    refs.dur.textContent = table.durationMinutes + '-minute meetings';
    cards[table.tableCode] = refs;
    return el;
  }

  /** Only rebuilds the queue rows when their content actually changed. */
  function renderCardQueue(refs, table) {
    var signature = [
      table.current ? table.current.id : 0,
      table.next ? table.next.id : 0,
      table.upcoming.map(function (a) { return a.id; }).join(','),
    ].join('|');
    if (refs.signature === signature) return;
    refs.signature = signature;

    refs.slots.innerHTML = '';
    refs.slots.appendChild(slot('NOW', table.current, 'No meeting in progress', true));
    refs.slots.appendChild(slot('NEXT', table.next, 'No queue waiting', false));

    var rest = table.upcoming.slice(1, 5);
    refs.upcomingWrap.hidden = rest.length === 0;
    refs.upcoming.innerHTML = '';
    rest.forEach(function (appointment) {
      var item = document.createElement('div');
      item.className = 'upcoming__item';
      var num = document.createElement('span');
      num.className = 'upcoming__num';
      num.textContent = appointment.queueNumber || appointment.scheduledStart;
      var co = document.createElement('span');
      co.className = 'upcoming__co';
      co.textContent = appointment.companyName;
      var time = document.createElement('span');
      time.className = 'upcoming__time';
      time.textContent = appointment.scheduledStart;
      item.appendChild(num);
      item.appendChild(co);
      item.appendChild(time);
      refs.upcoming.appendChild(item);
    });
  }

  var STATUS_TEXT = {
    scheduled: 'Scheduled',
    arrived: 'Checked in',
    called: 'Called',
    in_meeting: 'In meeting',
    completed: 'Completed',
    skipped: 'Skipped',
    no_show: 'No show',
  };

  function renderSearch() {
    if (!term) {
      resultsEl.hidden = true;
      resultsEl.innerHTML = '';
      return false;
    }

    var hits = [];
    state.tables.forEach(function (table) {
      var pool = [];
      var label = table.displayLabel || table.tableCode;
      if (table.current) pool.push({ appointment: table.current, position: 'Now at ' + label });
      table.upcoming.forEach(function (appointment, index) {
        pool.push({
          appointment: appointment,
          position: index === 0 ? 'Next at ' + label : index + 1 + ' in line at ' + label,
        });
      });
      pool.forEach(function (entry) {
        var a = entry.appointment;
        if (
          (a.queueNumber || '').toLowerCase().indexOf(term) !== -1 ||
          a.companyName.toLowerCase().indexOf(term) !== -1
        ) {
          hits.push({ entry: entry, table: table });
        }
      });
    });

    resultsEl.hidden = false;
    resultsEl.innerHTML = '';
    var title = document.createElement('p');
    title.className = 'results__title';
    title.textContent = hits.length
      ? hits.length + ' result' + (hits.length === 1 ? '' : 's') + ' for "' + searchEl.value.trim() + '"'
      : 'No queue found for "' + searchEl.value.trim() + '"';
    resultsEl.appendChild(title);

    hits.slice(0, 25).forEach(function (hit) {
      var a = hit.entry.appointment;
      var el = document.createElement('div');
      el.className = 'hit';
      el.innerHTML =
        '<div class="hit__top"><span class="hit__num"></span><span class="hit__table"></span></div>' +
        '<div class="hit__co"></div>' +
        '<div class="hit__foot"><span class="status-pill"></span><span class="hit__pos"></span></div>';
      el.querySelector('.hit__num').textContent = a.queueNumber || a.scheduledStart;
      el.querySelector('.hit__table').textContent = (hit.table.displayLabel || hit.table.tableCode) + ' · ' + a.scheduledStart;
      el.querySelector('.hit__co').textContent = a.companyName;
      var pill = el.querySelector('.status-pill');
      pill.textContent = STATUS_TEXT[a.appointmentStatus] || a.appointmentStatus;
      pill.className =
        'status-pill ' +
        (a.appointmentStatus === 'in_meeting'
          ? 'status-running'
          : a.appointmentStatus === 'called'
            ? 'status-paused'
            : 'status-ready');
      el.querySelector('.hit__pos').textContent = hit.entry.position;
      resultsEl.appendChild(el);
    });

    return true;
  }

  function render() {
    if (!state) return;
    renderSearch();

    var visible = state.tables.filter(matchesFilter);
    emptyEl.hidden = visible.length > 0;

    // Compare the table SET: both days have ten tables, so a count check would
    // keep day 1's Alibaba cards on screen for the whole of day 2.
    var signature = state.tables
      .map(function (t) { return t.tableCode + ':' + t.displayLabel; })
      .join('|');
    if (signature !== laidOutSignature) {
      laidOutSignature = signature;
      cards = {};
      tablesEl.innerHTML = '';
      state.tables.forEach(function (t) { tablesEl.appendChild(buildCard(t)); });
    }

    state.tables.forEach(function (table) {
      var refs = cards[table.tableCode];
      if (!refs) return;
      refs.root.hidden = !matchesFilter(table);
      renderCardQueue(refs, table);
    });
  }

  TopThai.onState(function (next) {
    var first = state === null;
    state = next;
    nameEl.textContent = next.event.name;
    dateEl.textContent = TopThai.bangkokDate(next.event.activeDate);
    // Rebuild the filter chips when the day's table set changes, or day 1's
    // table names would sit in the filter bar for the whole event.
    var chips = next.tables.map(function (t) { return t.tableCode + ':' + t.displayLabel; }).join('|');
    if (first || chipsEl.children.length === 0 || chips !== chipSignature) {
      chipSignature = chips;
      if (filter.indexOf('T:') === 0 && !next.tables.some(function (t) { return 'T:' + t.tableCode === filter; })) {
        filter = 'ALL';
      }
      buildChips(next);
    }
    render();
  });

  TopThai.onConnection(function (status) {
    connEl.className = 'conn is-' + status;
    connEl.textContent = status === 'live' ? 'Live' : status === 'connecting' ? 'Reconnecting' : 'Offline';
  });

  TopThai.startRenderLoop(function () {
    clockEl.textContent = TopThai.bangkokTime(false);
    syncEl.textContent = 'Synced ' + TopThai.lastSyncLabel();
    if (!state) return;

    state.tables.forEach(function (table) {
      var refs = cards[table.tableCode];
      if (!refs || refs.root.hidden) return;
      var remaining = TopThai.remainingSeconds(table.timer);
      refs.count.textContent = TopThai.formatMMSS(remaining);
      var classes = 'tcard__count count ' + TopThai.colorClass(remaining, table.timer.timerStatus);
      if (TopThai.shouldPulse(table.timer)) classes += ' is-pulsing';
      refs.count.className = classes.trim();
      refs.status.className = 'status-pill status-' + table.timer.timerStatus;
      refs.status.textContent = table.timer.statusLabel;
    });
  });

  TopThai.connect();
})();
