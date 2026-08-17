/* global TopThai */
/**
 * Bare clock control page.
 *
 * Every action is an authenticated POST to /api/control/bare/*; the socket is
 * only ever used to receive the clock snapshot. Nothing here can touch the
 * matching event - there is no endpoint on this page that reaches an
 * appointment, a matching table or an event day.
 *
 * The toast / api / confirm helpers are deliberately a local copy of the ones in
 * control.js rather than a shared module: control.js runs the room during the
 * event, and this feature is not a reason to edit it.
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

  // --- clock cards -------------------------------------------------------

  function clockById(id) {
    if (!state) return null;
    return state.clocks.filter(function (c) { return c.id === id; })[0] || null;
  }

  function buildCard(clock) {
    var el = document.createElement('article');
    el.className = 'ccard';
    el.innerHTML =
      '<div class="bcard__head">' +
      '<input class="bname" type="text" maxlength="40" aria-label="Clock name" />' +
      '<span class="status-pill status-ready"></span>' +
      '</div>' +
      '<div class="bcard__meta" data-role="meta"></div>' +
      '<div class="ccard__count count">--:--</div>' +
      '<div class="blen">' +
      '<input class="blen__input" type="text" inputmode="decimal" aria-label="Length in minutes" ' +
      'placeholder="minutes" />' +
      '<button class="btn btn--primary btn--sm" data-act="set">Set</button>' +
      '<button class="btn btn--ghost btn--sm" data-act="minus" title="Remove one minute">−1</button>' +
      '<button class="btn btn--ghost btn--sm" data-act="plus" title="Add one minute">+1</button>' +
      '</div>' +
      '<div class="bcard__controls">' +
      '<div class="bcard__controls-row">' +
      '<button class="btn btn--play" data-act="toggle">Play</button>' +
      '<button class="btn btn--ghost" data-act="reset">Reset</button>' +
      '</div>' +
      '<button class="btn btn--ghost btn--sm" data-act="delete">Delete clock</button>' +
      '</div>';

    var refs = {
      root: el,
      name: el.querySelector('.bname'),
      status: el.querySelector('.status-pill'),
      meta: el.querySelector('[data-role="meta"]'),
      count: el.querySelector('.ccard__count'),
      length: el.querySelector('.blen__input'),
      toggle: el.querySelector('[data-act="toggle"]'),
      reset: el.querySelector('[data-act="reset"]'),
    };
    refs.name.value = clock.label;

    var id = clock.id;
    var base = '/bare/clocks/' + id;

    /** Saves a rename, but only when the text actually changed. */
    function commitName() {
      var next = refs.name.value.trim();
      var current = clockById(id);
      var previous = current ? current.label : clock.label;
      if (!next) { refs.name.value = previous; return; }
      if (next === previous) return;
      api(base + '/label', { label: next })
        .then(function (data) { toast('Renamed to ' + data.label + '.'); })
        .catch(function () { refs.name.value = previous; });
    }

    refs.name.addEventListener('blur', commitName);
    refs.name.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); refs.name.blur(); }
      if (event.key === 'Escape') {
        var current = clockById(id);
        refs.name.value = current ? current.label : clock.label;
        refs.name.blur();
      }
    });

    function commitLength() {
      var typed = refs.length.value.trim();
      if (!typed) return;
      var current = clockById(id);
      var wasRunning = current && current.timer.timerStatus === 'running';
      api(base + '/duration', { duration: typed }).then(function (data) {
        refs.length.value = '';
        toast(
          nameOf(id) + ' set to ' + TopThai.formatMMSS(data.durationSeconds) +
            (wasRunning ? ' and still running.' : '. Press Play when you are ready.'),
        );
      });
    }

    el.querySelector('[data-act="set"]').addEventListener('click', commitLength);
    refs.length.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); commitLength(); }
    });

    el.querySelector('[data-act="plus"]').addEventListener('click', function () {
      api(base + '/adjust', { deltaSeconds: 60 });
    });
    el.querySelector('[data-act="minus"]').addEventListener('click', function () {
      api(base + '/adjust', { deltaSeconds: -60 });
    });

    refs.toggle.addEventListener('click', function () { api(base + '/toggle'); });
    refs.reset.addEventListener('click', function () { api(base + '/reset'); });

    el.querySelector('[data-act="delete"]').addEventListener('click', function () {
      confirmDialog(
        'Delete ' + nameOf(id) + '?',
        'The clock is removed from the board. This one cannot be undone by pressing the button again.',
        'Delete clock',
      ).then(function (ok) {
        if (!ok) return;
        api(base + '/delete').then(function (data) { toast(data.label + ' deleted.'); });
      });
    });

    cards[id] = refs;
    return el;
  }

  function nameOf(id) {
    var clock = clockById(id);
    return clock ? clock.label : 'This clock';
  }

  // --- global controls ---------------------------------------------------

  $('global-toggle').addEventListener('click', function () { api('/bare/global/toggle'); });

  $('global-reset').addEventListener('click', function () {
    confirmDialog(
      'Reset every clock?',
      'Each clock goes back to its own length and waits for Play. Names and lengths are not changed.',
      'Reset all clocks',
    ).then(function (ok) {
      if (ok) api('/bare/global/reset', { confirm: true }).then(function () { toast('All clocks reset.'); });
    });
  });

  // --- add a clock -------------------------------------------------------

  function closeAdd() { $('add-modal').hidden = true; }

  $('add-clock').addEventListener('click', function () {
    $('add-modal').hidden = false;
    $('add-label').value = '';
    $('add-duration').value = '';
    setTimeout(function () { $('add-label').focus(); }, 40);
  });
  $('add-close').addEventListener('click', closeAdd);
  $('add-cancel').addEventListener('click', closeAdd);

  $('add-form').addEventListener('submit', function (event) {
    event.preventDefault();
    api('/bare/clocks', {
      label: $('add-label').value,
      duration: $('add-duration').value,
    }).then(function (data) {
      closeAdd();
      toast(data.label + ' added to the board.');
    });
  });

  // --- render ------------------------------------------------------------

  TopThai.onState(function (next) {
    state = next;

    var toggle = $('global-toggle');
    toggle.textContent = next.global.label;
    toggle.className = 'btn btn--lg ' + (next.global.action === 'pause' ? 'btn--pause' : 'btn--play');
    toggle.disabled = next.clocks.length === 0;
    $('mixed-badge').hidden = !next.global.mixed;
    $('clock-count').textContent =
      next.clocks.length + (next.clocks.length === 1 ? ' clock' : ' clocks');
    $('empty-hint').hidden = next.clocks.length > 0;

    // Rebuild on a change of the clock SET only, so typing in a name or length
    // field is never interrupted by an incoming snapshot.
    var signature = next.clocks.map(function (c) { return c.id; }).join('|');
    if (signature !== laidOutSignature) {
      laidOutSignature = signature;
      cards = {};
      grid.innerHTML = '';
      next.clocks.forEach(function (clock) { grid.appendChild(buildCard(clock)); });
    }
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

    state.clocks.forEach(function (clock) {
      var refs = cards[clock.id];
      if (!refs) return;

      var remaining = TopThai.remainingSeconds(clock.timer);
      refs.count.textContent = TopThai.formatMMSS(remaining);
      var classes = 'ccard__count count ' + TopThai.colorClass(remaining, clock.timer.timerStatus);
      if (TopThai.shouldPulse(clock.timer)) classes += ' is-pulsing';
      refs.count.className = classes.trim();

      refs.status.className = 'status-pill status-' + clock.timer.timerStatus;
      refs.status.textContent = clock.timer.statusLabel;
      refs.meta.textContent = 'Length ' + TopThai.formatMMSS(clock.durationSeconds);

      // One button, three meanings - Play / Pause / Resume. There is no Stop.
      refs.toggle.textContent = clock.timer.toggleLabel;
      refs.toggle.className = 'btn ' + (clock.timer.toggleLabel === 'Pause' ? 'btn--pause' : 'btn--play');
      refs.toggle.disabled = !clock.timer.toggleEnabled;

      // A rename or a length typed here must never be overwritten mid-keystroke
      // by the 5-per-second render loop.
      if (document.activeElement !== refs.name) refs.name.value = clock.label;
    });
  });

  // --- boot --------------------------------------------------------------

  fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (data) { if (data.authenticated) showApp(); else showGate(); })
    .catch(showGate);

  TopThai.connect({
    stateEvent: 'bare:state',
    statePath: '/api/bare/state',
    query: { view: 'bare' },
  });
})();
