/* global io */
/**
 * Shared realtime client for /display, /live and /control.
 *
 * Two responsibilities:
 *  1. Keep a measured offset between this device's clock and the server's, so a
 *     phone with a wrong local time still renders the correct MM:SS.
 *  2. Hold the latest state snapshot and drive a render loop, recomputing the
 *     remaining time from `endsAt` rather than counting down locally. That is
 *     what makes a refresh, a reconnect or a sleeping phone come back correct.
 */
window.TopThai = (function () {
  var state = null;
  var offsetMs = 0;
  var offsetSamples = [];
  var connected = false;
  var lastSyncAt = 0;
  var pollTimer = null;
  var listeners = [];
  var connectionListeners = [];
  var socket = null;

  var POLL_MS = 3000;
  var RENDER_MS = 200;

  function serverNow() {
    return Date.now() + offsetMs;
  }

  /** Records an offset sample, keeping the one measured over the fastest round trip. */
  function recordSample(serverTime, sentAt, receivedAt) {
    var rtt = receivedAt - sentAt;
    var sample = { rtt: rtt, offset: serverTime + rtt / 2 - receivedAt };
    offsetSamples.push(sample);
    if (offsetSamples.length > 8) offsetSamples.shift();
    var best = offsetSamples[0];
    for (var i = 1; i < offsetSamples.length; i += 1) {
      if (offsetSamples[i].rtt < best.rtt) best = offsetSamples[i];
    }
    offsetMs = best.offset;
  }

  function syncClock() {
    var sentAt = Date.now();
    return fetch('/api/time', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        recordSample(data.serverTime, sentAt, Date.now());
        lastSyncAt = Date.now();
      })
      .catch(function () { /* offline; the indicator already says so */ });
  }

  function setConnection(next) {
    if (connected === next) return;
    connected = next;
    connectionListeners.forEach(function (fn) { fn(connectionStatus()); });
  }

  function connectionStatus() {
    if (connected) return 'live';
    if (lastSyncAt && Date.now() - lastSyncAt < 15000) return 'connecting';
    return 'offline';
  }

  var bootAssetVersion = null;

  /**
   * Reloads the page once when the server starts serving a newer frontend.
   *
   * Without this a screen left open across a deploy keeps running the code it
   * loaded, which fails silently: the markup looks right and the buttons simply
   * do nothing. The room display in particular may be on a wall nobody can
   * reach for hours.
   *
   * Guarded against loops by remembering the version we already reloaded for -
   * if the reload somehow does not pick up the new code, we stop rather than
   * refreshing forever.
   */
  function checkAssetVersion(version) {
    if (!version || version === 'unknown') return;
    if (bootAssetVersion === null) { bootAssetVersion = version; return; }
    if (version === bootAssetVersion) return;

    try {
      if (window.sessionStorage.getItem('topthai.reloadedFor') === version) return;
      window.sessionStorage.setItem('topthai.reloadedFor', version);
    } catch (error) { /* storage blocked; the check below still fires once */ }

    bootAssetVersion = version;
    window.location.reload();
  }

  function applyState(next) {
    state = next;
    lastSyncAt = Date.now();
    checkAssetVersion(next.assetVersion);
    listeners.forEach(function (fn) { fn(state); });
  }

  function pollOnce() {
    var sentAt = Date.now();
    return fetch('/api/state', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        recordSample(data.serverTime, sentAt, Date.now());
        applyState(data);
      })
      .catch(function () {
        connectionListeners.forEach(function (fn) { fn(connectionStatus()); });
      });
  }

  /** Short-interval polling is only a fallback for when the socket is down. */
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (!connected) pollOnce();
    }, POLL_MS);
  }

  function connect() {
    socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      timeout: 8000,
    });

    socket.on('connect', function () {
      setConnection(true);
      syncClock();
    });
    socket.on('disconnect', function () { setConnection(false); });
    socket.on('connect_error', function () { setConnection(false); });
    socket.on('state', function (data) {
      recordSample(data.serverTime, Date.now() - 20, Date.now());
      applyState(data);
    });
    socket.on('sync', function (data) {
      lastSyncAt = Date.now();
      recordSample(data.serverTime, Date.now() - 20, Date.now());
      connectionListeners.forEach(function (fn) { fn(connectionStatus()); });
    });

    extraEvents.forEach(function (pair) { socket.on(pair[0], pair[1]); });

    startPolling();
    syncClock().then(pollOnce);

    // A backgrounded tab or a sleeping phone gets a fresh clock sample and a
    // fresh snapshot the moment it comes back.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        syncClock();
        if (!connected) pollOnce();
        else if (socket) socket.connect();
      }
    });
    window.addEventListener('online', function () {
      syncClock();
      if (socket) socket.connect();
    });
    setInterval(syncClock, 60000);
  }

  // --- timer maths, mirroring src/timer.ts ---------------------------------

  function remainingSeconds(timer) {
    if (!timer) return 0;
    if (timer.timerStatus === 'running') {
      if (!timer.endsAt) return timer.durationSeconds;
      return Math.max(0, Math.ceil((Date.parse(timer.endsAt) - serverNow()) / 1000));
    }
    if (timer.timerStatus === 'timeup') return 0;
    var frozen = timer.pausedRemainingSeconds;
    return Math.max(0, frozen === null || frozen === undefined ? timer.durationSeconds : frozen);
  }

  function formatMMSS(seconds) {
    var total = Math.max(0, Math.floor(seconds));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function colorClass(seconds, status) {
    if (status === 'timeup' || seconds <= 0) return 'is-timeup';
    if (seconds <= 120) return 'is-critical';
    if (seconds <= 300) return 'is-warning';
    return '';
  }

  /** True for the first ten seconds after a timer hit zero. */
  function shouldPulse(timer) {
    if (!timer || timer.timerStatus !== 'timeup' || !timer.timeupAt) return false;
    return serverNow() - Date.parse(timer.timeupAt) < 10000;
  }

  function bangkokTime(withSeconds) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Bangkok',
      hour: '2-digit',
      minute: '2-digit',
      second: withSeconds ? '2-digit' : undefined,
      hour12: false,
    }).format(new Date(serverNow()));
  }

  function bangkokDate(value) {
    var date = value ? new Date(value + 'T00:00:00+07:00') : new Date(serverNow());
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Bangkok',
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(date);
  }

  function lastSyncLabel() {
    if (!lastSyncAt) return 'never';
    var seconds = Math.round((Date.now() - lastSyncAt) / 1000);
    if (seconds < 5) return 'just now';
    if (seconds < 60) return seconds + 's ago';
    return Math.floor(seconds / 60) + 'm ago';
  }

  /** Runs `fn` about five times a second - enough for a smooth seconds tick. */
  function startRenderLoop(fn) {
    var last = 0;
    function frame(ts) {
      if (ts - last >= RENDER_MS) {
        last = ts;
        try { fn(); } catch (error) { console.error(error); }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // Extra socket events a page wants, registered before or after connect().
  var extraEvents = [];

  return {
    connect: connect,
    /**
     * Subscribe to a raw socket event (e.g. the operator-only 'grid:changed').
     * Lets a page share this one connection instead of opening a second.
     */
    on: function (event, handler) {
      extraEvents.push([event, handler]);
      if (socket) socket.on(event, handler);
    },
    onState: function (fn) { listeners.push(fn); if (state) fn(state); },
    onConnection: function (fn) { connectionListeners.push(fn); fn(connectionStatus()); },
    getState: function () { return state; },
    connectionStatus: connectionStatus,
    lastSyncLabel: lastSyncLabel,
    serverNow: serverNow,
    remainingSeconds: remainingSeconds,
    formatMMSS: formatMMSS,
    colorClass: colorClass,
    shouldPulse: shouldPulse,
    bangkokTime: bangkokTime,
    bangkokDate: bangkokDate,
    startRenderLoop: startRenderLoop,
    refresh: pollOnce,
  };
})();
