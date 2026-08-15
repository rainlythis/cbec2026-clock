/* global TopThai */
/**
 * Operator control page.
 *
 * Every action here is an authenticated POST to /api/control/*; the socket is
 * only ever used to receive state. Nothing on this page can be triggered
 * without the session cookie the server set after a correct passcode.
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };

  var gate = $('gate');
  var app = $('app');
  var grid = $('cgrid');
  var toastEl = $('toast');

  var state = null;
  var cards = {};
  var laidOutSignature = '';
  var openMenu = null;
  var queueTableCode = null;
  var queueFilter = 'waiting';
  var toastTimer = null;

  // --- helpers -----------------------------------------------------------

  function toast(message, isError) {
    toastEl.textContent = message;
    toastEl.className = 'toast' + (isError ? ' is-error' : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, isError ? 5200 : 2600);
  }

  function api(path, body) {
    return fetch('/api/control' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (response.status === 401) {
            showGate();
            throw new Error('Session expired. Please sign in again.');
          }
          if (!response.ok || data.ok === false) {
            throw new Error(data.message || 'The action could not be applied.');
          }
          return data;
        });
      })
      .catch(function (error) {
        toast(error.message || 'Network error. Nothing was changed.', true);
        throw error;
      });
  }

  function get(path) {
    return fetch('/api/control' + path, { credentials: 'same-origin', cache: 'no-store' }).then(
      function (r) {
        if (r.status === 401) { showGate(); throw new Error('Session expired.'); }
        return r.json();
      },
    );
  }

  /** Promise-based confirmation dialog; resolves false on cancel. */
  function confirmDialog(title, body, confirmLabel) {
    return new Promise(function (resolve) {
      var modal = $('confirm-modal');
      $('confirm-title').textContent = title;
      $('confirm-body').textContent = body;
      $('confirm-ok').textContent = confirmLabel || 'Confirm';
      modal.hidden = false;

      function done(result) {
        modal.hidden = true;
        $('confirm-ok').removeEventListener('click', onOk);
        $('confirm-cancel').removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }
      function onOk() { done(true); }
      function onCancel() { done(false); }
      function onKey(event) { if (event.key === 'Escape') done(false); }

      $('confirm-ok').addEventListener('click', onOk);
      $('confirm-cancel').addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
    });
  }

  // --- authentication ----------------------------------------------------

  function showGate() {
    gate.hidden = false;
    app.hidden = true;
    setTimeout(function () { $('passcode').focus(); }, 50);
  }

  function showApp() {
    gate.hidden = true;
    app.hidden = false;
  }

  $('login-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var error = $('login-error');
    var submit = $('login-submit');
    error.hidden = true;
    submit.disabled = true;

    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: $('passcode').value }),
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) throw new Error(data.message || 'Sign-in failed.');
          return data;
        });
      })
      .then(function () {
        $('passcode').value = '';
        showApp();
        TopThai.refresh();
      })
      .catch(function (err) {
        error.textContent = err.message;
        error.hidden = false;
      })
      .finally(function () { submit.disabled = false; });
  });

  $('logout').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).then(showGate);
  });

  // --- table cards -------------------------------------------------------

  function buildCard(table) {
    var el = document.createElement('article');
    el.className = 'ccard' + (table.zone === 'shopee' ? ' ccard--shopee' : '');
    el.innerHTML =
      '<div class="ccard__head">' +
      '<div><span class="ccard__name"></span><span class="ccard__dur"></span></div>' +
      '<span class="status-pill status-ready"></span>' +
      '</div>' +
      '<div class="ccard__count count">--:--</div>' +
      '<div class="ccard__queue">' +
      '<div class="qrow qrow--now"><span class="qrow__label">NOW</span>' +
      '<div class="qrow__body"><div class="qrow__num"></div><div class="qrow__co"></div></div></div>' +
      '<div class="qrow qrow--next"><span class="qrow__label">NEXT</span>' +
      '<div class="qrow__body"><div class="qrow__num"></div><div class="qrow__co"></div></div></div>' +
      '</div>' +
      '<div class="ccard__stats"><span data-stat="waiting"></span>' +
      '<span data-stat="completed"></span><span data-stat="skipped"></span></div>' +
      '<div class="ccard__controls">' +
      '<div class="ccard__controls-row">' +
      '<button class="btn btn--play" data-act="toggle">Play</button>' +
      '<button class="btn btn--ghost" data-act="reset">Reset</button>' +
      '</div>' +
      '<div class="ccard__controls-row ccard__controls-row--three">' +
      '<button class="btn btn--primary btn--sm" data-act="complete">Complete &amp; Next</button>' +
      '<button class="btn btn--ghost btn--sm" data-act="skip">Skip &amp; Next</button>' +
      '<div class="menu"><button class="btn btn--ghost btn--sm" data-act="more" aria-haspopup="true">⋯</button></div>' +
      '</div>' +
      '</div>';

    var refs = {
      root: el,
      name: el.querySelector('.ccard__name'),
      dur: el.querySelector('.ccard__dur'),
      count: el.querySelector('.ccard__count'),
      status: el.querySelector('.status-pill'),
      nowNum: el.querySelector('.qrow--now .qrow__num'),
      nowCo: el.querySelector('.qrow--now .qrow__co'),
      nowRow: el.querySelector('.qrow--now'),
      nextNum: el.querySelector('.qrow--next .qrow__num'),
      nextCo: el.querySelector('.qrow--next .qrow__co'),
      nextRow: el.querySelector('.qrow--next'),
      stats: {
        waiting: el.querySelector('[data-stat="waiting"]'),
        completed: el.querySelector('[data-stat="completed"]'),
        skipped: el.querySelector('[data-stat="skipped"]'),
      },
      toggle: el.querySelector('[data-act="toggle"]'),
      reset: el.querySelector('[data-act="reset"]'),
      complete: el.querySelector('[data-act="complete"]'),
      skip: el.querySelector('[data-act="skip"]'),
      more: el.querySelector('[data-act="more"]'),
      menuWrap: el.querySelector('.menu'),
    };

    // The operator sees the day's vendor label, matching the spreadsheet.
    refs.name.textContent = table.displayLabel || table.tableCode;
    refs.dur.textContent = ' · ' + table.durationMinutes + ' min' + (table.isActive ? '' : ' · closed today');

    var code = table.tableCode;

    refs.toggle.addEventListener('click', function () { api('/tables/' + encodeURIComponent(code) + '/toggle'); });

    refs.reset.addEventListener('click', function () {
      var snapshot = tableByCode(code);
      var isActive = snapshot && snapshot.timer.timerStatus !== 'ready';
      if (!isActive) {
        api('/tables/' + encodeURIComponent(code) + '/reset');
        return;
      }
      confirmDialog(
        'Reset ' + code + '?',
        'The timer will go back to ' + (snapshot ? snapshot.durationMinutes : '') +
          ':00. The queue is not changed and the current company stays at this table.',
        'Reset timer',
      ).then(function (ok) { if (ok) api('/tables/' + encodeURIComponent(code) + '/reset'); });
    });

    refs.complete.addEventListener('click', function () {
      api('/tables/' + encodeURIComponent(code) + '/complete-next').then(function () {
        toast(code + ': meeting completed, next queue loaded (timer ready, not started).');
      });
    });

    refs.skip.addEventListener('click', function () {
      var snapshot = tableByCode(code);
      var who = snapshot && snapshot.current ? snapshot.current.queueNumber : 'the current queue';
      confirmDialog(
        'Skip ' + who + '?',
        'They will be marked as skipped and kept in the schedule, so you can recall them later from the queue list.',
        'Skip & Next',
      ).then(function (ok) {
        if (!ok) return;
        api('/tables/' + encodeURIComponent(code) + '/skip-next').then(function () {
          toast(code + ': queue skipped, next queue loaded (timer ready, not started).');
        });
      });
    });

    refs.more.addEventListener('click', function (event) {
      event.stopPropagation();
      toggleMenu(code, refs);
    });

    cards[code] = refs;
    return el;
  }

  function tableByCode(code) {
    if (!state) return null;
    return state.tables.filter(function (t) { return t.tableCode === code; })[0] || null;
  }

  // --- "More" menu -------------------------------------------------------

  function closeMenu() {
    if (openMenu) { openMenu.remove(); openMenu = null; }
  }
  document.addEventListener('click', closeMenu);

  function toggleMenu(code, refs) {
    var wasOpen = openMenu && openMenu.dataset.code === code;
    closeMenu();
    if (wasOpen) return;

    var table = tableByCode(code);
    var panel = document.createElement('div');
    panel.className = 'menu__panel';
    panel.dataset.code = code;
    panel.addEventListener('click', function (event) { event.stopPropagation(); });

    function item(label, handler) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu__item';
      button.textContent = label;
      button.addEventListener('click', function () { closeMenu(); handler(); });
      panel.appendChild(button);
    }
    function separator() {
      var line = document.createElement('div');
      line.className = 'menu__sep';
      panel.appendChild(line);
    }

    item('Add one minute', function () {
      confirmDialog('Add one minute to ' + code + '?', 'The countdown will gain 60 seconds.', 'Add 1:00')
        .then(function (ok) {
          if (ok) api('/tables/' + encodeURIComponent(code) + '/adjust', { deltaSeconds: 60 });
        });
    });
    item('Remove one minute', function () {
      confirmDialog('Remove one minute from ' + code + '?', 'The countdown will lose 60 seconds.', 'Remove 1:00')
        .then(function (ok) {
          if (ok) api('/tables/' + encodeURIComponent(code) + '/adjust', { deltaSeconds: -60 });
        });
    });
    separator();
    item('Manage queue / recall skipped…', function () { openQueue(code); });
    separator();

    if (table && table.timer.timerStatus === 'break') {
      item('End break (re-open table)', function () {
        api('/tables/' + encodeURIComponent(code) + '/presence', { status: 'ready' });
      });
    } else {
      item('Put table on break', function () {
        api('/tables/' + encodeURIComponent(code) + '/presence', { status: 'break' });
      });
    }
    if (table && table.timer.timerStatus === 'closed') {
      item('Re-open table', function () {
        api('/tables/' + encodeURIComponent(code) + '/presence', { status: 'ready' });
      });
    } else {
      item('Close table for today', function () {
        confirmDialog('Close ' + code + '?', 'The table will show as Closed on every screen.', 'Close table')
          .then(function (ok) {
            if (ok) api('/tables/' + encodeURIComponent(code) + '/presence', { status: 'closed' });
          });
      });
    }

    refs.menuWrap.appendChild(panel);
    openMenu = panel;
  }

  // --- queue manager -----------------------------------------------------

  var QUEUE_FILTERS = [
    { key: 'waiting', label: 'Waiting' },
    { key: 'skipped', label: 'Skipped' },
    { key: 'completed', label: 'Completed' },
    { key: 'all', label: 'All' },
  ];

  var STATUS_TEXT = {
    scheduled: 'Scheduled',
    arrived: 'Arrived',
    called: 'Called',
    in_meeting: 'In meeting',
    completed: 'Completed',
    skipped: 'Skipped',
    no_show: 'No show',
  };

  function openQueue(code) {
    queueTableCode = code;
    $('queue-title').textContent = 'Queue — ' + code;
    $('queue-modal').hidden = false;
    renderQueueFilters();
    loadQueue();
  }

  $('queue-close').addEventListener('click', function () {
    $('queue-modal').hidden = true;
    queueTableCode = null;
  });

  function renderQueueFilters() {
    var wrap = $('queue-filters');
    wrap.innerHTML = '';
    QUEUE_FILTERS.forEach(function (option) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn--sm' + (queueFilter === option.key ? ' btn--primary' : ' btn--ghost');
      button.textContent = option.label;
      button.addEventListener('click', function () {
        queueFilter = option.key;
        renderQueueFilters();
        loadQueue();
      });
      wrap.appendChild(button);
    });
  }

  function loadQueue() {
    if (!queueTableCode) return;
    var table = tableByCode(queueTableCode);
    var currentId = table && table.current ? table.current.id : null;

    get('/appointments').then(function (data) {
      var list = $('queue-list');
      list.innerHTML = '';

      var rows = data.appointments.filter(function (a) {
        if (a.tableCode !== queueTableCode) return false;
        if (queueFilter === 'waiting') return a.appointmentStatus === 'scheduled' || a.appointmentStatus === 'arrived';
        if (queueFilter === 'skipped') return a.appointmentStatus === 'skipped' || a.appointmentStatus === 'no_show';
        if (queueFilter === 'completed') return a.appointmentStatus === 'completed';
        return true;
      });

      if (rows.length === 0) {
        var empty = document.createElement('p');
        empty.className = 'modal__body';
        empty.textContent = 'Nothing in this list.';
        list.appendChild(empty);
        return;
      }

      rows.forEach(function (a) {
        var item = document.createElement('div');
        item.className = 'qitem' + (a.id === currentId ? ' is-current' : '');

        var num = document.createElement('span');
        num.className = 'qitem__num';
        num.textContent = a.queueNumber;

        var co = document.createElement('span');
        co.className = 'qitem__co';
        co.textContent = a.companyName;

        var time = document.createElement('span');
        time.className = 'qitem__time';
        time.textContent = a.scheduledStart + '–' + a.scheduledEnd;

        var pill = document.createElement('span');
        pill.className = 'status-pill';
        pill.textContent = a.id === currentId ? 'At table' : STATUS_TEXT[a.appointmentStatus] || a.appointmentStatus;

        var actions = document.createElement('span');
        actions.className = 'qitem__actions';

        function action(label, handler, primary) {
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn btn--sm ' + (primary ? 'btn--primary' : 'btn--ghost');
          button.textContent = label;
          button.addEventListener('click', function () {
            handler().then(function () { loadQueue(); }).catch(function () {});
          });
          actions.appendChild(button);
        }

        if (a.appointmentStatus === 'scheduled') {
          action('Mark arrived', function () {
            return api('/appointments/' + a.id + '/arrival', { arrived: true });
          }, true);
        } else if (a.appointmentStatus === 'arrived') {
          action('Undo arrival', function () {
            return api('/appointments/' + a.id + '/arrival', { arrived: false });
          });
        }

        if (a.appointmentStatus === 'skipped' || a.appointmentStatus === 'no_show') {
          action('Recall', function () { return api('/appointments/' + a.id + '/recall'); }, true);
        }

        if (a.id !== currentId && a.appointmentStatus !== 'completed') {
          action('Set as current', function () {
            return api('/tables/' + encodeURIComponent(queueTableCode) + '/select', { appointmentId: a.id });
          });
        }

        item.appendChild(num);
        item.appendChild(co);
        item.appendChild(time);
        item.appendChild(pill);
        item.appendChild(actions);
        list.appendChild(item);
      });
    });
  }

  // --- global controls ---------------------------------------------------

  $('global-toggle').addEventListener('click', function () {
    api('/global/toggle');
  });

  $('global-reset').addEventListener('click', function () {
    confirmDialog(
      'Reset every timer?',
      'All ten tables go back to their full duration (15:00, or 10:00 at SHOPEE). ' +
        'Queues and companies are not changed.',
      'Reset all timers',
    ).then(function (ok) {
      if (ok) api('/global/reset', { confirm: true }).then(function () { toast('All timers reset.'); });
    });
  });

  $('sound-toggle').addEventListener('click', function () {
    var enabled = !(state && state.event.soundEnabled);
    api('/settings/sound', { enabled: enabled }).then(function () {
      toast('Room sound ' + (enabled ? 'enabled on the room display' : 'muted'));
    });
  });

  $('date-select').addEventListener('change', function (event) {
    api('/settings/active-date', { date: event.target.value });
  });

  // --- CSV import --------------------------------------------------------

  var importCsv = '';

  $('import-open').addEventListener('click', function () {
    $('import-modal').hidden = false;
    $('import-report').hidden = true;
    $('import-apply').disabled = true;
  });
  $('import-close').addEventListener('click', function () { $('import-modal').hidden = true; });

  $('import-file').addEventListener('change', function (event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;
    file.text().then(function (text) {
      importCsv = text;
      $('import-text').value = text.length > 6000 ? text.slice(0, 6000) + '\n… (truncated preview)' : text;
      $('import-apply').disabled = true;
      $('import-report').hidden = true;
    });
  });

  $('import-text').addEventListener('input', function (event) {
    importCsv = event.target.value;
    $('import-apply').disabled = true;
  });

  function renderImportReport(data, ok) {
    var report = $('import-report');
    report.hidden = false;
    report.className = 'import-report ' + (ok ? 'is-ok' : 'is-bad');
    report.innerHTML = '';

    var summary = document.createElement('div');
    if (ok) {
      summary.textContent =
        data.validRows + ' of ' + data.totalRows + ' rows are valid for ' + (data.dates || []).join(', ') +
        '. Press Import to replace the schedule for those dates.';
    } else {
      summary.textContent = data.message || 'The file could not be imported.';
    }
    report.appendChild(summary);

    if (data.errors && data.errors.length) {
      var list = document.createElement('ul');
      data.errors.slice(0, 40).forEach(function (error) {
        var li = document.createElement('li');
        li.textContent =
          'Line ' + error.line + ' · ' + error.column +
          (error.value ? ' ("' + error.value + '")' : '') + ' — ' + error.message;
        list.appendChild(li);
      });
      report.appendChild(list);
      if (data.errors.length > 40) {
        var more = document.createElement('div');
        more.textContent = '…and ' + (data.errors.length - 40) + ' more.';
        report.appendChild(more);
      }
    }
  }

  $('import-validate').addEventListener('click', function () {
    if (!importCsv.trim()) { toast('Choose a CSV file or paste its contents first.', true); return; }
    fetch('/api/control/schedule/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ csv: importCsv, dryRun: true }),
    })
      .then(function (response) {
        return response.json().then(function (data) {
          renderImportReport(data, response.ok && data.ok);
          $('import-apply').disabled = !(response.ok && data.ok);
        });
      })
      .catch(function () { toast('Validation failed. Check the connection.', true); });
  });

  $('import-apply').addEventListener('click', function () {
    confirmDialog(
      'Import this schedule?',
      'Every appointment for the dates in this file is replaced. Timer states are kept, but each table’s current company is cleared.',
      'Import schedule',
    ).then(function (ok) {
      if (!ok) return;
      api('/schedule/import', { csv: importCsv }).then(function (data) {
        $('import-modal').hidden = true;
        toast('Imported ' + data.inserted + ' appointments for ' + data.replacedDates.join(', '));
      });
    });
  });

  // --- render ------------------------------------------------------------

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

  function currentSession(next) {
    var now = TopThai.bangkokTime(false);
    var found = null;
    next.event.sessions.forEach(function (s) {
      if (now >= s.start && now < s.end) found = s.label + ' · ' + s.start + '–' + s.end;
    });
    if (found) return found;
    var upcoming = next.event.sessions.filter(function (s) { return now < s.start; })[0];
    return upcoming ? 'Break · next ' + upcoming.start : 'Outside session hours';
  }

  TopThai.onState(function (next) {
    state = next;
    $('event-name').textContent = next.event.name;

    var select = $('date-select');
    if (select.options.length !== next.event.eventDates.length) {
      select.innerHTML = '';
      next.event.eventDates.forEach(function (date) {
        var option = document.createElement('option');
        option.value = date;
        option.textContent = TopThai.bangkokDate(date);
        select.appendChild(option);
      });
    }
    select.value = next.event.activeDate;

    var sound = $('sound-toggle');
    sound.textContent = 'Room sound: ' + (next.event.soundEnabled ? 'On' : 'Off');
    sound.setAttribute('aria-pressed', String(next.event.soundEnabled));

    var toggle = $('global-toggle');
    toggle.textContent = next.global.label;
    toggle.className = 'btn btn--lg ' + (next.global.action === 'pause' ? 'btn--pause' : 'btn--play');
    $('mixed-badge').hidden = !next.global.mixed;

    // Rebuild on a change of table SET, not of table count - both days have
    // ten tables but positions 7 and 8 change vendor between them.
    var signature = next.tables
      .map(function (t) { return t.tableCode + ':' + t.displayLabel; })
      .join('|');
    if (signature !== laidOutSignature) {
      laidOutSignature = signature;
      cards = {};
      grid.innerHTML = '';
      next.tables.forEach(function (table) { grid.appendChild(buildCard(table)); });
    }

    if (queueTableCode && !$('queue-modal').hidden) loadQueue();
  });

  TopThai.onConnection(function (status) {
    var el = $('conn');
    el.className = 'conn is-' + status;
    el.textContent = status === 'live' ? 'Live' : status === 'connecting' ? 'Reconnecting' : 'Offline';
  });

  TopThai.startRenderLoop(function () {
    $('clock').textContent = TopThai.bangkokTime(true);
    $('sync').textContent = 'synced ' + TopThai.lastSyncLabel();
    if (!state) return;
    $('session-name').textContent = currentSession(state);

    state.tables.forEach(function (table) {
      var refs = cards[table.tableCode];
      if (!refs) return;

      var remaining = TopThai.remainingSeconds(table.timer);
      refs.count.textContent = TopThai.formatMMSS(remaining);
      var classes = 'ccard__count count ' + TopThai.colorClass(remaining, table.timer.timerStatus);
      if (TopThai.shouldPulse(table.timer)) classes += ' is-pulsing';
      refs.count.className = classes.trim();

      refs.status.className = 'status-pill status-' + table.timer.timerStatus;
      refs.status.textContent = table.timer.statusLabel;

      // One button, three meanings - Play / Pause / Resume. There is no Stop.
      refs.toggle.textContent = table.timer.toggleLabel;
      refs.toggle.className =
        'btn ' + (table.timer.toggleLabel === 'Pause' ? 'btn--pause' : 'btn--play');
      refs.toggle.disabled = !table.timer.toggleEnabled;

      refs.complete.disabled = !table.current;
      refs.skip.disabled = !table.current;

      renderQueueRow(refs.nowNum, refs.nowCo, refs.nowRow, table.current, 'No company loaded');
      renderQueueRow(refs.nextNum, refs.nextCo, refs.nextRow, table.next, 'No queue waiting');

      refs.stats.waiting.textContent = table.stats.waiting + ' waiting';
      refs.stats.completed.textContent = table.stats.completed + ' done';
      refs.stats.skipped.textContent = table.stats.skipped + ' skipped';
    });
  });

  // --- boot --------------------------------------------------------------

  fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (data) { if (data.authenticated) showApp(); else showGate(); })
    .catch(showGate);

  TopThai.connect();
})();
