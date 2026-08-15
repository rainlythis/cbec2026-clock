/* global TopThai, io */
/**
 * Operator schedule grid.
 *
 * Renders the approved workbook's time x table matrix and makes it editable.
 * Every mutation is an authenticated POST; grid deltas arrive on a Socket.IO
 * room that only a signed-in operator can join.
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };

  var gate = $('gate');
  var app = $('app');
  var toastEl = $('toast');

  var grid = null;          // last full payload
  var date = null;          // the day being edited
  var activeDate = null;    // the day showing in the room
  var selection = null;     // a cell picked up for move/swap
  var toastTimer = null;
  var socket = null;

  // --- helpers -----------------------------------------------------------

  function toast(message, kind) {
    toastEl.textContent = message;
    toastEl.className = 'toast' + (kind === 'error' ? ' is-error' : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, kind === 'error' ? 6000 : 3000);
  }

  function api(path, body) {
    return fetch('/api/control' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (response.status === 401) { showGate(); throw new Error('Session expired. Please sign in again.'); }
        if (!response.ok || data.ok === false) throw new Error(data.message || 'That change could not be applied.');
        return data;
      });
    }).catch(function (error) {
      toast(error.message || 'Network error. Nothing was changed.', 'error');
      // A rejected edit usually means our copy is stale, so resync.
      load(date);
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
      function onKey(e) { if (e.key === 'Escape') done(false); }
      $('confirm-ok').addEventListener('click', onOk);
      $('confirm-cancel').addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
    });
  }

  // --- auth --------------------------------------------------------------

  function showGate() { gate.hidden = false; app.hidden = true; setTimeout(function () { $('passcode').focus(); }, 50); }
  function showApp() { gate.hidden = true; app.hidden = false; }

  $('login-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var error = $('login-error');
    error.hidden = true;
    $('login-submit').disabled = true;
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: $('passcode').value }),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.message || 'Sign-in failed.');
        return d;
      }); })
      .then(function () {
        $('passcode').value = '';
        showApp();
        connectSocket();
        load(date);
      })
      .catch(function (err) { error.textContent = err.message; error.hidden = false; })
      .finally(function () { $('login-submit').disabled = false; });
  });

  // --- data --------------------------------------------------------------

  function load(forDate) {
    var query = forDate ? '?date=' + encodeURIComponent(forDate) : '';
    return fetch('/api/control/grid' + query, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) { showGate(); throw new Error('unauthorized'); }
        return r.json();
      })
      .then(function (data) {
        grid = data;
        date = data.date;
        activeDate = data.activeDate;
        render();
      })
      .catch(function () { /* the gate or a toast has already reported it */ });
  }

  function cellsByKey() {
    var map = {};
    grid.cells.forEach(function (c) { map[c.tableCode + '|' + c.slotId] = c; });
    return map;
  }

  // --- rendering ---------------------------------------------------------

  function statusClass(cell) {
    if (!cell) return 'cell--empty';
    if (cell.isCurrent || cell.appointmentStatus === 'in_meeting' || cell.appointmentStatus === 'called') return 'cell--live';
    if (cell.appointmentStatus === 'completed') return 'cell--done';
    if (cell.appointmentStatus === 'skipped' || cell.appointmentStatus === 'no_show') return 'cell--gone';
    if (cell.arrivalStatus === 'arrived') return 'cell--arrived';
    return '';
  }

  function buildMatrix(target, gridKey) {
    var tables = grid.tables.filter(function (t) { return t.gridKey === gridKey; });
    var slots = grid.slots.filter(function (s) { return s.gridKey === gridKey; })
      .sort(function (a, b) { return a.slotIndex - b.slotIndex; });
    var byKey = cellsByKey();

    var html = '<thead><tr><th class="timecol">Time</th>';
    tables.forEach(function (t) {
      html += '<th class="' + (t.isActive ? '' : 'is-closed') + '">' +
        escapeHtml(t.displayLabel) + (t.isActive ? '' : ' <small>(closed)</small>') + '</th>';
    });
    html += '</tr></thead><tbody>';

    var previousEnd = null;
    slots.forEach(function (slot) {
      // A gap between one slot's end and the next slot's start is a break in
      // the day; show it as a rule so the grid reads like the spreadsheet.
      var isAfterBreak = previousEnd !== null && previousEnd !== slot.startsAt;
      previousEnd = slot.endsAt;

      html += '<tr class="' + (isAfterBreak ? 'after-break' : '') + '">';
      html += '<th class="timecol">' + slot.startsAt + '</th>';
      tables.forEach(function (table) {
        var cell = byKey[table.tableCode + '|' + slot.id];
        if (!table.isActive) {
          html += '<td class="is-closed"></td>';
          return;
        }
        var classes = ['cell', statusClass(cell)];
        if (cell && cell.frozen) classes.push('cell--frozen');
        if (cell && cell.moved) classes.push('cell--moved');
        if (selection && cell && selection.appointmentId === cell.appointmentId) classes.push('cell--selected');
        else if (selection && !cell) classes.push('cell--target');

        html += '<td><button type="button" class="' + classes.join(' ') + '"' +
          ' data-table="' + escapeHtml(table.tableCode) + '"' +
          ' data-slot="' + slot.id + '"' +
          (cell ? ' data-appointment="' + cell.appointmentId + '"' : '') + '>';
        if (cell) {
          html += '<span class="cell__co">' + escapeHtml(cell.companyName) + '</span>' +
            '<span class="cell__meta">' + escapeHtml(cell.queueNumber || '') +
            (cell.frozen ? ' · ' + escapeHtml(statusText(cell)) : '') +
            (cell.moved ? ' · moved' : '') + '</span>';
        } else {
          html += '<span class="cell__co">—</span>';
        }
        html += '</button></td>';
      });
      html += '</tr>';
    });

    html += '</tbody>';
    target.innerHTML = html;
  }

  var STATUS_TEXT = {
    scheduled: 'waiting', arrived: 'arrived', called: 'called', in_meeting: 'at table',
    completed: 'done', skipped: 'skipped', no_show: 'no-show',
  };
  function statusText(cell) {
    if (cell.isCurrent) return 'at table';
    return STATUS_TEXT[cell.appointmentStatus] || cell.appointmentStatus;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderDayTabs() {
    var tabs = $('daytabs');
    var days = [
      { date: '2026-08-17', label: 'Mon 17 Aug' },
      { date: '2026-08-18', label: 'Tue 18 Aug' },
    ];
    tabs.innerHTML = '';
    days.forEach(function (day) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'daytab' + (day.date === date ? ' is-active' : '');
      button.textContent = day.label;
      button.addEventListener('click', function () {
        selection = null;
        load(day.date);
      });
      tabs.appendChild(button);
    });
    $('live-flag').hidden = date !== activeDate;
  }

  function renderParked() {
    var section = $('parked-section');
    var list = $('parked-list');
    section.hidden = grid.parked.length === 0;
    $('parked-count').textContent = grid.parked.length;
    list.innerHTML = '';
    grid.parked.forEach(function (cell) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'parked__item';
      button.innerHTML = '<span>' + escapeHtml(cell.companyName) + '</span><small>' +
        escapeHtml(cell.tableCode) + ' · ' + escapeHtml(statusText(cell)) + '</small>';
      button.addEventListener('click', function () {
        selection = { appointmentId: cell.appointmentId, rowVersion: cell.rowVersion, companyName: cell.companyName, parked: true };
        toast('Now click a free cell to place ' + cell.companyName + '.');
        render();
      });
      list.appendChild(button);
    });
  }

  function render() {
    if (!grid) return;
    $('grid-sub').textContent = grid.tables.length + ' tables · ' +
      grid.cells.length + ' appointments · ' + TopThai.bangkokDate(date);
    renderDayTabs();
    buildMatrix($('matrix-main'), 'main');
    buildMatrix($('matrix-shopee'), 'shopee');
    renderParked();
    $('hint').textContent = selection
      ? 'Moving ' + selection.companyName + ' — click a destination cell, or press Escape to cancel.'
      : 'Click a cell to act on it. Locked cells are already called or finished.';
    bindCells();
  }

  function bindCells() {
    Array.prototype.forEach.call(document.querySelectorAll('.cell'), function (button) {
      button.addEventListener('click', function () { onCellClick(button); });
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && selection) { selection = null; render(); }
  });

  // --- cell interaction --------------------------------------------------

  function findCell(appointmentId) {
    var all = grid.cells.concat(grid.parked);
    for (var i = 0; i < all.length; i += 1) if (all[i].appointmentId === appointmentId) return all[i];
    return null;
  }

  function onCellClick(button) {
    var tableCode = button.getAttribute('data-table');
    var slotId = Number(button.getAttribute('data-slot'));
    var appointmentId = button.hasAttribute('data-appointment')
      ? Number(button.getAttribute('data-appointment'))
      : null;
    var cell = appointmentId ? findCell(appointmentId) : null;

    // Second click of a move: place, or swap with whoever is there.
    if (selection) {
      if (cell && cell.appointmentId === selection.appointmentId) { selection = null; render(); return; }
      var moving = selection;
      selection = null;
      if (!cell) {
        api('/grid/cell/move', {
          appointmentId: moving.appointmentId,
          tableCode: tableCode,
          slotId: slotId,
          expectedVersion: moving.rowVersion,
        }).then(function (r) { reportResult(r, 'Moved ' + moving.companyName + '.'); });
      } else if (cell.frozen) {
        toast(cell.companyName + ' is locked — that cell has already been called or finished.', 'error');
        render();
      } else {
        api('/grid/cell/swap', {
          firstId: moving.appointmentId,
          secondId: cell.appointmentId,
          firstVersion: moving.rowVersion,
          secondVersion: cell.rowVersion,
        }).then(function (r) { reportResult(r, 'Swapped ' + moving.companyName + ' and ' + cell.companyName + '.'); });
      }
      return;
    }

    if (!cell) { toast('That cell is empty. Pick a company from the grid or the parked tray first.'); return; }
    openCellSheet(cell, tableCode, slotId);
  }

  /**
   * A column push can produce a dozen clashes at once, so they are summarised
   * rather than dumped into a toast - with the full list one click away.
   */
  function reportResult(result, message) {
    var warnings = (result && result.warnings) || [];
    if (warnings.length === 0) {
      toast(message);
    } else if (warnings.length === 1) {
      toast(message + ' ' + warnings[0], 'error');
    } else {
      toast(message + ' ' + warnings.length + ' clashes — click to review.', 'error');
      toastEl.onclick = function () {
        window.alert('Please check these:\n\n• ' + warnings.join('\n• '));
        toastEl.onclick = null;
        toastEl.hidden = true;
      };
    }
    load(date);
  }

  function openCellSheet(cell, tableCode, slotId) {
    var modal = $('cell-modal');
    $('cell-title').textContent = cell.companyName;
    $('cell-meta').textContent = tableCode + ' · ' + (cell.queueNumber || '') + ' · ' +
      cell.scheduledStart + ' · ' + statusText(cell) + (cell.moved ? ' · moved from its original slot' : '');
    var actions = $('cell-actions');
    var contact = $('contact');
    contact.hidden = true;
    contact.innerHTML = '';
    actions.innerHTML = '';
    modal.hidden = false;

    function action(label, className, handler) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn ' + className;
      button.textContent = label;
      button.addEventListener('click', handler);
      actions.appendChild(button);
      return button;
    }

    if (cell.frozen) {
      var note = document.createElement('p');
      note.className = 'modal__body';
      note.textContent = cell.isCurrent
        ? 'This company is at the table right now. Use Complete & Next or Skip & Next on the timers page before changing the grid.'
        : 'This appointment has already been called or finished. It stays in the record; recall it from the timers page if they come back.';
      actions.appendChild(note);
    } else {
      // Two no-show behaviours. Marking alone is the safe default: the queue
      // engine calls the next company early by itself, and the rest of the day
      // keeps its planned times. Pushing the column up re-times everybody
      // below, which is occasionally what you want but usually creates clashes
      // with those companies' own bookings at other tables.
      action('No-show — keep the times', 'btn--danger', function () {
        modal.hidden = true;
        confirmDialog(
          'Mark ' + cell.companyName + ' as a no-show?',
          'They stay in the record and can be recalled. ' + tableCode +
            ' will simply call the next company early; nobody else is re-timed.',
          'Mark no-show',
        ).then(function (ok) {
          if (!ok) return;
          api('/grid/cell/no-show-push', {
            appointmentId: cell.appointmentId,
            expectedVersion: cell.rowVersion,
            push: false,
          }).then(function (r) { reportResult(r, cell.companyName + ' marked no-show.'); });
        });
      });

      action('No-show — push whole queue up', 'btn--ghost', function () {
        modal.hidden = true;
        confirmDialog(
          'Push the ' + tableCode + ' queue up?',
          cell.companyName + ' is marked no-show and everyone later at this table moves up one slot. ' +
            'Meetings already called or finished stay put. Some companies may end up double-booked ' +
            'with their meetings at other tables — you will get a list.',
          'Push queue up',
        ).then(function (ok) {
          if (!ok) return;
          api('/grid/cell/no-show-push', {
            appointmentId: cell.appointmentId,
            expectedVersion: cell.rowVersion,
            push: true,
          }).then(function (r) { reportResult(r, cell.companyName + ' marked no-show; queue pushed up.'); });
        });
      });

      action('Move or swap…', 'btn--primary', function () {
        modal.hidden = true;
        selection = { appointmentId: cell.appointmentId, rowVersion: cell.rowVersion, companyName: cell.companyName };
        toast('Click the destination cell for ' + cell.companyName + '.');
        render();
      });

      action('Rename company…', 'btn--ghost', function () {
        var next = window.prompt('Company name', cell.companyName);
        if (next === null || next.trim() === '' || next === cell.companyName) return;
        modal.hidden = true;
        api('/grid/cell/rename', { appointmentId: cell.appointmentId, companyName: next })
          .then(function (r) { reportResult(r, 'Renamed.'); });
      });

      action('Take off the grid', 'btn--ghost', function () {
        modal.hidden = true;
        confirmDialog(
          'Take ' + cell.companyName + ' off the grid?',
          'They move to the parked tray: still in the roster and recallable, but they will not be called until you place them back.',
          'Park them',
        ).then(function (ok) {
          if (!ok) return;
          api('/grid/cell/clear', { appointmentId: cell.appointmentId, expectedVersion: cell.rowVersion })
            .then(function (r) { reportResult(r, cell.companyName + ' parked.'); });
        });
      });
    }

    if (cell.hasContact) {
      action('Show contact details', 'btn--ghost', function () {
        fetch('/api/control/appointments/' + cell.appointmentId + '/contact', {
          credentials: 'same-origin', cache: 'no-store',
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data.ok) throw new Error(data.message || 'Not available.');
            contact.hidden = false;
            contact.innerHTML = '<dl>' +
              (data.contactNames ? '<dt>Contact</dt><dd>' + escapeHtml(data.contactNames) + '</dd>' : '') +
              (data.contactEmails ? '<dt>Email</dt><dd>' + escapeHtml(data.contactEmails) + '</dd>' : '') +
              (data.province ? '<dt>Province</dt><dd>' + escapeHtml(data.province) + '</dd>' : '') +
              (data.productCategory ? '<dt>Products</dt><dd>' + escapeHtml(data.productCategory) + '</dd>' : '') +
              '</dl>';
          })
          .catch(function (error) { toast(error.message, 'error'); });
      });
    }
  }

  $('cell-close').addEventListener('click', function () { $('cell-modal').hidden = true; });
  $('pick-close').addEventListener('click', function () { $('pick-modal').hidden = true; });

  $('export').addEventListener('click', function () {
    window.location.href = '/api/control/grid/export.csv?date=' + encodeURIComponent(date);
  });

  // --- realtime ----------------------------------------------------------

  function connectSocket() {
    if (socket) return;
    socket = io({ transports: ['websocket', 'polling'], reconnection: true });
    socket.on('connect', function () { setConn('live'); load(date); });
    socket.on('disconnect', function () { setConn('offline'); });
    socket.on('connect_error', function () { setConn('offline'); });
    socket.on('grid:changed', function (payload) {
      if (!grid || payload.date !== date) return;
      // Another tab (or the timers page) changed something; take the delta.
      if (payload.gridRevision <= grid.gridRevision) return;
      load(date);
    });
    // A timer action can change which cell is "at table", so follow those too.
    socket.on('state', function () { if (grid) load(date); });
  }

  function setConn(status) {
    var el = $('conn');
    el.className = 'conn is-' + status;
    el.textContent = status === 'live' ? 'Live' : status === 'offline' ? 'Offline' : 'Reconnecting';
  }

  // --- boot --------------------------------------------------------------

  var params = new URLSearchParams(window.location.search);
  date = params.get('date');

  fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.authenticated) { showGate(); return; }
      showApp();
      connectSocket();
      return load(date);
    })
    .catch(showGate);
})();
