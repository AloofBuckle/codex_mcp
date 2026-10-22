(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PAGE_STATE_KEY = 'mcpmonitor-page-state-v1';
  const NOTIFICATIONS_ENABLED_KEY = 'mcpmonitor-notifications-enabled-v1';
  const ZOOM_LEVELS = Object.freeze([100, 125, 150, 175, 200, 225, 250, 300, 350]);
  const AV1_WEBCODECS_CODEC = 'av01.0.10M.08';
  // Keep remote wheel delivery aligned with the 120 Hz display without ever
  // building a long-lived scroll backlog. Chromium saturates a single injected
  // axis event around this range, so larger aggregates only add lag
  // (and sufficiently large discrete values can be discarded entirely).
  const BROWSER_WHEEL_FLUSH_MS = 8;
  const BROWSER_WHEEL_PACKET_LIMIT = 960;
  const BROWSER_WHEEL_BACKLOG_LIMIT = BROWSER_WHEEL_PACKET_LIMIT * 4;
  const LIST_PINNED_DISCOVERY_LIMIT = 16;
  const MAIN_AUTO_COLLAPSE_WIDTH = 120;
  // Chromium's Wayland backend converts wl_pointer axis values to wheel
  // deltas at 12 CSS px per axis unit (axis / 10 * kWheelDelta, kWheelDelta=120).
  // Convert DOM pixel distance back to Wayland units once so remote scrolling
  // remains 1:1 with the client.
  const BROWSER_WHEEL_SENSITIVITY = 1 / 12;
  function safeStorageGet(key) {
    try {
      return window.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  function safeStorageSet(key, value) {
    try {
      window.localStorage?.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }
  function safeStorageRemove(key) {
    try {
      window.localStorage?.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }
  function readStoredJson(key) {
    try {
      return JSON.parse(safeStorageGet(key) || 'null');
    } catch {
      return null;
    }
  }
  const savedPageState = readStoredJson(PAGE_STATE_KEY) || {};
  const savedFilter = [
    'all',
    'exec_command',
    'apply_patch',
    'view_image',
    'write_stdin',
    'browser',
  ].includes(savedPageState.filter)
    ? savedPageState.filter
    : 'all';
  const savedTimeRange = ['1d', '24h', '3d', '7d', '1m', 'all', 'custom'].includes(
    savedPageState.timeRange,
  )
    ? savedPageState.timeRange
    : '24h';
  const savedCustomStart =
    typeof savedPageState.customStart === 'string' ? savedPageState.customStart : '';
  const savedCustomEnd =
    typeof savedPageState.customEnd === 'string' ? savedPageState.customEnd : '';
  const savedSearch =
    typeof savedPageState.search === 'string' ? savedPageState.search.slice(0, 512) : '';
  const savedFollow = typeof savedPageState.follow === 'boolean' ? savedPageState.follow : true;
  const savedSidebarCollapsed =
    typeof savedPageState.sidebarCollapsed === 'boolean' ? savedPageState.sidebarCollapsed : false;
  const savedSidebarWidth = Number(savedPageState.sidebarWidth || 0);
  const savedMainCollapsed =
    typeof savedPageState.mainCollapsed === 'boolean' ? savedPageState.mainCollapsed : false;
  const savedZoomCandidate = Number(savedPageState.zoom);
  const savedZoom = ZOOM_LEVELS.includes(savedZoomCandidate) ? savedZoomCandidate : 100;
  const legacyTheme = safeStorageGet('mcpmonitor-theme');
  const savedThemeExplicit =
    typeof savedPageState.dark === 'boolean' || legacyTheme === 'dark' || legacyTheme === 'light';
  const savedThemeDark =
    typeof savedPageState.dark === 'boolean'
      ? savedPageState.dark
      : legacyTheme === 'dark'
        ? true
        : legacyTheme === 'light'
          ? false
          : true;
  const savedVideoMonitorOpen =
    typeof savedPageState.videoMonitor?.open === 'boolean'
      ? savedPageState.videoMonitor.open
      : typeof savedPageState.browser?.open === 'boolean'
        ? savedPageState.browser.open
        : false;
  const savedVideoMonitorReopenMainCollapsed =
    savedPageState.videoMonitor?.reopenMainCollapsed === true;
  const savedBrowserAudioEnabled =
    typeof savedPageState.browser?.audioEnabled === 'boolean'
      ? savedPageState.browser.audioEnabled
      : true;
  const savedVideoMonitorPanelWidth = Number(
    savedPageState.videoMonitor?.panelWidth ??
      savedPageState.browser?.panelWidth ??
      safeStorageGet('mcpmonitor-browser-width') ??
      0,
  );
  const readUnitPosition = (value) => {
    const x = Number(value?.x);
    const y = Number(value?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  };
  const savedBrowserControlPosition = readUnitPosition(savedPageState.browser?.controlPosition);
  const savedNativeControlPosition = readUnitPosition(savedPageState.native?.controlPosition);
  let savedBrowserSurfaceCollapsed = savedPageState.browser?.surfaceCollapsed === true;
  let savedNativeSurfaceCollapsed = savedPageState.native?.surfaceCollapsed === true;
  if (savedBrowserSurfaceCollapsed && savedNativeSurfaceCollapsed)
    savedNativeSurfaceCollapsed = false;
  const state = {
    stats: {
      files_changed: 0,
      additions: 0,
      deletions: 0,
      command_calls: 0,
      cua_calls: 0,
      tool_calls: 0,
    },
    listGeneration: 0,
    listCaches: new Map(),
    listRender: {
      start: 0,
      end: 0,
      raf: 0,
      ensureTimer: null,
    },
    selected: null,
    detail: null,
    detailLoading: false,
    userInputDrafts: new Map(),
    filter: savedFilter,
    search: savedSearch,
    timeRange: savedTimeRange,
    customSince: null,
    customUntil: null,
    customStart: savedCustomStart,
    customEnd: savedCustomEnd,
    follow: savedFollow,
    followPauseExplicit: false,
    sidebarCollapsed: savedSidebarCollapsed,
    sidebarWidth: Number.isFinite(savedSidebarWidth) ? savedSidebarWidth : 0,
    mainCollapsed: savedMainCollapsed,
    zoom: savedZoom,
    sidebarResizing: false,
    sidebarResizerPointerId: null,
    sidebarResizerStartX: 0,
    sidebarResizerStartWidth: 0,
    dark: savedThemeDark,
    themeExplicit: savedThemeExplicit,
    source: null,
    listSync: {
      mode: 'live',
      revision: 0,
      from: 0,
      to: 0,
      applied: 0,
      total: 0,
      reconcilePromise: null,
      reconcileRequested: false,
      pendingChanges: [],
      hiddenAt: document.visibilityState === 'hidden' ? Date.now() : null,
      lastForegroundReconcileAt: 0,
      foregroundVerifyPending: false,
      verifyTimer: null,
    },
    authenticated: false,
    connection: 'connecting',
    connectionMessage: '正在连接',
    push: {
      registration: null,
      enabled: safeStorageGet(NOTIFICATIONS_ENABLED_KEY) === '1',
      subscribed: false,
      publicKey: null,
      syncing: false,
    },
    videoMonitor: {
      open: savedVideoMonitorOpen,
      reopenMainCollapsed: savedVideoMonitorReopenMainCollapsed,
      panelWidth: Number.isFinite(savedVideoMonitorPanelWidth) ? savedVideoMonitorPanelWidth : 0,
      resizingPanel: false,
      resizerPointerId: null,
      resizerStartX: 0,
      resizerStartWidth: 0,
    },
    browser: {
      surfaceCollapsed: savedBrowserSurfaceCollapsed,
      controlPosition: savedBrowserControlPosition,
      ws: null,
      reconnectTimer: null,
      resumeTimer: null,
      resumeForceFresh: false,
      suspendedAt: document.visibilityState === 'hidden' ? Date.now() : null,
      lifecycleHeartbeatAt: Date.now(),
      status: 'idle',
      statusMessage: '未连接',
      data: null,
      audio: {
        enabled: savedBrowserAudioEnabled,
        pc: null,
        element: null,
        context: null,
        source: null,
        stream: null,
        connectPromise: null,
        reconnectTimer: null,
        disconnectTimer: null,
        generation: 0,
        status: 'idle',
        statusMessage: '未连接',
      },
      agentCursor: {
        renderedX: null,
        renderedY: null,
        renderedSize: null,
        lastSeq: null,
        lastUpdatedAt: null,
        lastAction: null,
        moveTimer: null,
        pulseTimer: null,
        pulseCleanupTimer: null,
      },
      video: {
        rtcPc: null,
        connectPromise: null,
        renderedFrames: 0,
        reemoMainRenderer: null,
        decoder: null,
        reconnectTimer: null,
        disconnectTimer: null,
        generation: 0,
        status: 'idle',
        statusMessage: '未连接',
        fps: 120,
        width: 0,
        height: 0,
      },
      nextId: 1,
      pointerDown: false,
      pointerButton: 'left',
      pointerId: null,
      pointerType: null,
      pointerStart: null,
      pointerLast: null,
      pointerStartClient: null,
      pointerDragging: false,
      lastPointerClickAt: 0,
      movePending: null,
      moveRaf: 0,
      wheelPending: null,
      wheelTimer: 0,
      pressedKeys: new Set(),
    },
    nativeLive: {
      surfaceCollapsed: savedNativeSurfaceCollapsed,
      controlPosition: savedNativeControlPosition,
      pc: null,
      dc: null,
      connectPromise: null,
      reconnectTimer: null,
      disconnectTimer: null,
      generation: 0,
      status: 'idle',
      statusMessage: '未连接',
      width: 1920,
      height: 1080,
      codec: 'av1',
      fps: 120,
      health: null,
      healthFetchedAt: 0,
      renderer: null,
      pointerId: null,
      pressedKeys: new Set(),
      pendingMotion: null,
      motionRaf: 0,
      cursor: {
        t: 'cursor',
        x: 0,
        y: 0,
        visible: false,
        shape: 'default',
        hotspotX: 0,
        hotspotY: 0,
      },
    },
  };

  function persistPageState() {
    const payload = {
      version: 1,
      filter: state.filter,
      search: state.search,
      timeRange: state.timeRange,
      customStart: state.customStart,
      customEnd: state.customEnd,
      follow: !!state.follow,
      sidebarCollapsed: !!state.sidebarCollapsed,
      sidebarWidth: Number(state.sidebarWidth || 0),
      mainCollapsed: !!state.mainCollapsed,
      zoom: state.zoom,
      videoMonitor: {
        open: !!state.videoMonitor.open,
        reopenMainCollapsed: !!state.videoMonitor.reopenMainCollapsed,
        panelWidth: Number(state.videoMonitor.panelWidth || 0),
      },
      browser: {
        surfaceCollapsed: !!state.browser.surfaceCollapsed,
        audioEnabled: !!state.browser.audio.enabled,
        controlPosition: state.browser.controlPosition
          ? { ...state.browser.controlPosition }
          : null,
      },
      native: {
        surfaceCollapsed: !!state.nativeLive.surfaceCollapsed,
        controlPosition: state.nativeLive.controlPosition
          ? { ...state.nativeLive.controlPosition }
          : null,
      },
    };
    if (state.themeExplicit) payload.dark = !!state.dark;
    // Safari private/restricted storage and embedded WebViews can expose the
    // Storage API while throwing SecurityError/QuotaExceededError on access.
    // Treat persistence as optional so the monitor remains fully usable when
    // local storage is unavailable; only cross-reload state retention is lost.
    if (!safeStorageSet(PAGE_STATE_KEY, JSON.stringify(payload))) return;
    // One-time migration from the older per-control keys.
    safeStorageRemove('mcpmonitor-theme');
    safeStorageRemove('mcpmonitor-video-backend-v1');
    safeStorageRemove('mcpmonitor-browser-width');
    safeStorageRemove('mcpmonitor-browser-overlay-position-v1');
  }

  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (ch) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[ch],
    );
  function createListCache() {
    return {
      generation: state.listGeneration,
      revision: 0,
      count: null,
      items: new Map(),
      byId: new Map(),
      pending: new Map(),
    };
  }
  function listCache(filter = state.filter) {
    let cache = state.listCaches.get(filter);
    if (!cache || cache.generation !== state.listGeneration) {
      cache = createListCache();
      state.listCaches.set(filter, cache);
    }
    return cache;
  }
  function resetListCaches() {
    state.listGeneration += 1;
    state.listCaches.clear();
    clearTimeout(state.listRender.ensureTimer);
    state.listRender.ensureTimer = null;
    if (state.listRender.raf) cancelAnimationFrame(state.listRender.raf);
    state.listRender.raf = 0;
    state.listRender.start = 0;
    state.listRender.end = 0;
  }
  function rebuildCacheIds(cache) {
    cache.byId.clear();
    for (const [index, call] of cache.items) {
      if (call?.id) cache.byId.set(call.id, index);
    }
  }
  function cachedCall(id) {
    if (!id) return null;
    const active = listCache();
    const activeIndex = active.byId.get(id);
    if (activeIndex != null)
      return { call: active.items.get(activeIndex), index: activeIndex, cache: active };
    for (const cache of state.listCaches.values()) {
      const index = cache.byId.get(id);
      if (index != null) return { call: cache.items.get(index), index, cache };
    }
    return null;
  }
  const formatTime = (stamp) =>
    stamp
      ? new Date(Number(stamp)).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      : '—';
  const formatDateTime = (stamp) => (stamp ? new Date(Number(stamp)).toLocaleString() : '—');
  const padDatePart = (value) => String(value).padStart(2, '0');
  function localDateKey(stamp) {
    if (!stamp) return '';
    const date = new Date(Number(stamp));
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
  }
  function formatCallListTime(stamp, now = Date.now()) {
    if (!stamp) return '—';
    const date = new Date(Number(stamp));
    if (Number.isNaN(date.getTime())) return '—';
    const current = new Date(now);
    const time = formatTime(stamp);
    if (localDateKey(stamp) === localDateKey(now)) return time;
    const monthDay = `${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
    return date.getFullYear() === current.getFullYear()
      ? `${monthDay} ${time}`
      : `${date.getFullYear()}-${monthDay} ${time}`;
  }
  const formatDuration = (ms) =>
    ms == null ? '进行中' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  const statusText = (status) =>
    ({ running: '执行中', completed: '已完成', failed: '失败', interrupted: '终态未知' })[status] || status || '未知';
  const statusClass = (status) =>
    status === 'failed'
      ? 'failed'
      : status === 'running'
        ? 'running'
        : status === 'interrupted'
          ? 'interrupted'
          : 'completed';
  const toolIcon = (tool) =>
    ({
      exec_command: '›_',
      apply_patch: '✎',
      request_user_input: '?',
      request_user_input_async: '?',
      view_image: '▧',
      write_stdin: '↳',
      browser_click: '⌖',
      browser_drag: '↗',
      browser_scroll: '↕',
      browser_key: '⌨',
      browser_type: 'T',
      browser_action: '◎',
    })[tool] || '·';
  const terminalIcon = () =>
    '<svg class="terminal-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="3.5" width="19" height="17" rx="3"/><path d="M7 8.5l3 3-3 3M12.5 14.5H17"/></svg>';
  const LIST_ROW_HEIGHT = 48;
  const FOLLOW_TOP_EPSILON = 8;
  const LIST_PREFETCH_VIEWPORTS = 4;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const customScrollbars = new WeakMap();
  const rangeLabels = {
    '1d': '今天',
    '24h': '最近 24 小时',
    '3d': '最近 3 天',
    '7d': '最近 7 天',
    '1m': '最近 1 个月',
    all: '全部记录',
    custom: '自选日期',
  };

  function ensureCustomScrollbarShell(host) {
    let shell = host.parentElement;
    if (shell?.classList.contains('scroll-shell')) return shell;
    shell = document.createElement('div');
    shell.className = 'scroll-shell inline-scroll-shell';
    host.before(shell);
    shell.append(host);
    const rail = document.createElement('div');
    rail.className = 'custom-scrollbar';
    rail.setAttribute('aria-hidden', 'true');
    rail.innerHTML = '<div class="custom-scrollbar-thumb"></div>';
    shell.append(rail);
    return shell;
  }

  function attachCustomScrollbar(host) {
    if (!host || customScrollbars.has(host)) return customScrollbars.get(host) || null;
    const shell = ensureCustomScrollbarShell(host);
    const rail = Array.from(shell.children).find((node) =>
      node.classList?.contains('custom-scrollbar'),
    );
    const thumb = rail?.querySelector('.custom-scrollbar-thumb');
    if (!rail || !thumb) return null;
    host.classList.add('custom-scroll-host');

    const state = {
      raf: 0,
      dragging: false,
      pointerId: null,
      startY: 0,
      startScrollTop: 0,
      startThumbTop: 0,
      thumbHeight: 0,
      travel: 0,
      maxScroll: 0,
    };
    const syncNow = () => {
      state.raf = 0;
      const client = Math.max(0, host.clientHeight);
      const scroll = Math.max(client, host.scrollHeight);
      const track = Math.max(0, rail.clientHeight);
      const maxScroll = Math.max(0, scroll - client);
      const active = maxScroll > 1 && track > 0;
      rail.classList.toggle('active', active);
      if (!active) {
        thumb.style.height = '0px';
        thumb.style.transform = 'translate3d(0,0,0)';
        state.thumbHeight = state.travel = state.maxScroll = 0;
        return;
      }
      const thumbHeight = Math.min(track, Math.max(30, Math.round((track * client) / scroll)));
      const travel = Math.max(0, track - thumbHeight);
      const top = travel * Math.min(1, Math.max(0, host.scrollTop / maxScroll));
      state.thumbHeight = thumbHeight;
      state.travel = travel;
      state.maxScroll = maxScroll;
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translate3d(0,${top}px,0)`;
    };
    const sync = () => {
      if (state.raf) return;
      state.raf = requestAnimationFrame(syncNow);
    };

    host.addEventListener('scroll', sync, { passive: true });
    rail.addEventListener('pointerdown', (event) => {
      if (!rail.classList.contains('active')) return;
      event.preventDefault();
      if (event.target === thumb) return;
      const rect = rail.getBoundingClientRect();
      const scale = uiScaleFactor();
      const targetTop = Math.max(
        0,
        Math.min(state.travel, (event.clientY - rect.top) / scale - state.thumbHeight / 2),
      );
      host.scrollTop = state.travel > 0 ? (targetTop / state.travel) * state.maxScroll : 0;
      sync();
    });
    thumb.addEventListener('pointerdown', (event) => {
      if (!rail.classList.contains('active')) return;
      event.preventDefault();
      event.stopPropagation();
      state.dragging = true;
      state.pointerId = event.pointerId;
      state.startY = event.clientY;
      state.startScrollTop = host.scrollTop;
      state.startThumbTop =
        state.maxScroll > 0 ? (state.travel * host.scrollTop) / state.maxScroll : 0;
      rail.classList.add('dragging');
      try {
        thumb.setPointerCapture(event.pointerId);
      } catch {}
    });
    thumb.addEventListener('pointermove', (event) => {
      if (!state.dragging || event.pointerId !== state.pointerId) return;
      event.preventDefault();
      const top = Math.max(
        0,
        Math.min(
          state.travel,
          state.startThumbTop + (event.clientY - state.startY) / uiScaleFactor(),
        ),
      );
      host.scrollTop =
        state.travel > 0 ? (top / state.travel) * state.maxScroll : state.startScrollTop;
      sync();
    });
    const finishDrag = (event) => {
      if (!state.dragging || (event?.pointerId != null && event.pointerId !== state.pointerId))
        return;
      state.dragging = false;
      state.pointerId = null;
      rail.classList.remove('dragging');
      try {
        thumb.releasePointerCapture(event?.pointerId);
      } catch {}
      sync();
    };
    thumb.addEventListener('pointerup', finishDrag);
    thumb.addEventListener('pointercancel', finishDrag);

    const resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(host);
    const mutationObserver = new MutationObserver(sync);
    mutationObserver.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });

    const api = {
      sync,
      destroy: () => {
        resizeObserver.disconnect();
        mutationObserver.disconnect();
      },
    };
    customScrollbars.set(host, api);
    sync();
    return api;
  }

  function refreshCustomScrollbars(root = document) {
    const staticHosts = [$('call-list'), $('detail')].filter(Boolean);
    for (const host of staticHosts) attachCustomScrollbar(host)?.sync();
    if (root?.querySelectorAll) {
      for (const host of root.querySelectorAll('.code-block,.patch'))
        attachCustomScrollbar(host)?.sync();
    }
  }

  function monthAgo(now) {
    const current = new Date(now);
    const day = current.getDate();
    const target = new Date(current);
    target.setDate(1);
    target.setMonth(target.getMonth() - 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(day, lastDay));
    return target.getTime();
  }

  function rangeCutoff(range, now = Date.now()) {
    if (range === 'all') return null;
    if (range === '1d') {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start.getTime();
    }
    const minute = 60 * 1000;
    const rounded = Math.floor(now / minute) * minute;
    if (range === '24h') return rounded - DAY_MS;
    if (range === '3d') return rounded - 3 * DAY_MS;
    if (range === '7d') return rounded - 7 * DAY_MS;
    if (range === '1m') return Math.floor(monthAgo(rounded) / minute) * minute;
    return rounded - DAY_MS;
  }

  function parseLocalDate(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day, 0, 0, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day)
      return null;
    return date;
  }

  function customRangeBounds(startValue, endValue) {
    const start = parseLocalDate(startValue);
    const end = parseLocalDate(endValue);
    if (!start || !end) return null;
    if (start.getTime() > end.getTime()) return null;
    const until = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1, 0, 0, 0, 0);
    return { since: start.getTime(), until: until.getTime() };
  }

  function restorePageStateToControls() {
    const customBounds =
      state.timeRange === 'custom' ? customRangeBounds(state.customStart, state.customEnd) : null;
    if (state.timeRange === 'custom' && !customBounds) {
      state.timeRange = '24h';
    } else if (customBounds) {
      state.customSince = customBounds.since;
      state.customUntil = customBounds.until;
    }

    $('search').value = state.search;
    document.querySelectorAll('.filter').forEach((button) => {
      button.classList.toggle('active', button.dataset.filter === state.filter);
    });
    document.querySelectorAll('.range-filter').forEach((button) => {
      button.classList.toggle(
        'active',
        state.timeRange !== 'custom' && button.dataset.range === state.timeRange,
      );
    });
    $('custom-date-start').value = state.customStart;
    $('custom-date-end').value = state.customEnd;
    // Deliberately do not restore call-list.scrollTop. A reload always starts
    // the virtualized tool list from its normal top position.
    $('call-list').scrollTop = 0;
  }

  function callTiming(call) {
    const startedAt = Number(call?.started_at || 0);
    const endedAt = Number(call?.ended_at || 0);
    const background = call?.tool === 'exec_command' && call?.background === true;
    const running = call?.status === 'running';
    const durationMs =
      call?.duration_ms == null && running && startedAt
        ? Math.max(0, Date.now() - startedAt)
        : call?.duration_ms;
    const interrupted = call?.status === 'interrupted';
    const showStart = background || running || !endedAt;
    return {
      label: interrupted ? '失联' : showStart ? '开始' : '完成',
      stamp: interrupted ? endedAt || startedAt : showStart ? startedAt : endedAt,
      duration: interrupted ? '终态未知' : formatDuration(durationMs),
    };
  }

  function callTimingHtml(call) {
    const timing = callTiming(call);
    return `<span class="call-timing"><span title="${escape(formatDateTime(timing.stamp))}">${timing.label} ${escape(formatCallListTime(timing.stamp))}</span><span class="call-timing-sep">·</span><span>${escape(timing.duration)}</span></span>`;
  }

  function callAction(call) {
    if (call.status === 'interrupted') return '终态未知';
    if (call.tool === 'exec_command')
      return call.status === 'running'
        ? '运行中'
        : call.status === 'failed'
          ? '运行失败'
          : '已运行';
    if (call.tool === 'apply_patch')
      return call.status === 'running'
        ? '编辑中'
        : call.status === 'failed'
          ? '编辑失败'
          : '已编辑';
    if (call.tool === 'view_image')
      return call.status === 'running'
        ? '查看中'
        : call.status === 'failed'
          ? '查看失败'
          : '已查看';
    if (call.tool === 'write_stdin')
      return call.status === 'running'
        ? '输入中'
        : call.status === 'failed'
          ? '输入失败'
          : '已输入';
    if (call.tool === 'request_user_input' || call.tool === 'request_user_input_async')
      return call.status === 'running' ? '等待回答' : call.status === 'failed' ? '提问失败' : '已结束';
    if (call.tool === 'browser_click')
      return call.status === 'running'
        ? '点击中'
        : call.status === 'failed'
          ? '点击失败'
          : '已点击';
    if (call.tool === 'browser_drag')
      return call.status === 'running'
        ? '拖动中'
        : call.status === 'failed'
          ? '拖动失败'
          : '已拖动';
    if (call.tool === 'browser_scroll')
      return call.status === 'running'
        ? '滚动中'
        : call.status === 'failed'
          ? '滚动失败'
          : '已滚动';
    if (call.tool === 'browser_key')
      return call.status === 'running'
        ? '按键中'
        : call.status === 'failed'
          ? '按键失败'
          : '已按键';
    if (call.tool === 'browser_type')
      return call.status === 'running'
        ? '输入中'
        : call.status === 'failed'
          ? '输入失败'
          : '已输入';
    if (call.tool === 'browser_action')
      return call.status === 'running'
        ? '操作中'
        : call.status === 'failed'
          ? '操作失败'
          : '已操作';
    return statusText(call.status);
  }

  function callInlineHtml(call) {
    return `<span class="call-action">${escape(callAction(call))}</span><span class="call-primary mono">${escape(call.title || call.tool || '工具调用')}</span>`;
  }

  function setTheme({ persist = true } = {}) {
    document.documentElement.classList.toggle('dark', state.dark);
    if (persist) persistPageState();
  }

  function uiScaleFactor() {
    return Math.max(1, Number(state.zoom || 100)) / 100;
  }

  function logicalViewportWidth() {
    const width = Number(window.innerWidth || document.documentElement.clientWidth || 0);
    return width / uiScaleFactor();
  }

  function logicalViewportHeight() {
    const height = Number(window.innerHeight || document.documentElement.clientHeight || 0);
    return height / uiScaleFactor();
  }

  function logicalElementWidth(element) {
    return Number(element?.getBoundingClientRect().width || 0) / uiScaleFactor();
  }

  function setZoom({ persist = true } = {}) {
    const zoom = ZOOM_LEVELS.includes(Number(state.zoom)) ? Number(state.zoom) : 100;
    state.zoom = zoom;
    const scale = zoom / 100;
    document.documentElement.style.removeProperty('zoom');
    document.documentElement.style.setProperty('--ui-scale', String(scale));
    document.documentElement.style.setProperty('--ui-inverse-scale', String(1 / scale));
    if ($('zoom').value !== String(zoom)) $('zoom').value = String(zoom);
    if (persist) persistPageState();
    requestAnimationFrame(() => {
      if (logicalViewportWidth() <= 720 && state.mainCollapsed)
        setMainCollapsed(false, { persist: false });
      if (state.sidebarWidth > 0) applySidebarWidth(state.sidebarWidth);
      if (!state.mainCollapsed && state.videoMonitor.panelWidth > 0)
        applyBrowserPanelWidth(state.videoMonitor.panelWidth);
      refreshCustomScrollbars();
      renderAgentCursor();
      renderNativeCursorOverlay();
    });
  }

  function pushPublicKeyBytes(value) {
    const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  }

  function pushSubscriptionPayload(subscription) {
    const json = subscription?.toJSON?.() || {};
    return {
      endpoint: subscription?.endpoint || json.endpoint || '',
      keys: {
        p256dh: json.keys?.p256dh || '',
        auth: json.keys?.auth || '',
      },
    };
  }

  function updateNotificationButton() {
    const button = $('notifications');
    if (!button) return;
    button.setAttribute('aria-pressed', String(state.push.enabled));
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      button.textContent = '通知×';
      button.disabled = true;
      button.title = '当前浏览器不支持 Web Push';
      return;
    }
    if (Notification.permission === 'denied') {
      state.push.enabled = false;
      state.push.subscribed = false;
      safeStorageSet(NOTIFICATIONS_ENABLED_KEY, '0');
      button.textContent = '通知×';
      button.disabled = true;
      button.title = '系统通知权限已被拒绝';
      return;
    }
    button.disabled = state.push.syncing || !state.authenticated;
    button.textContent = state.push.enabled ? '通知✓' : '通知';
    button.title = state.push.syncing
      ? '正在更新系统通知'
      : state.push.enabled
        ? '点击关闭系统通知'
        : '点击启用系统通知';
  }

  async function savePushSubscription(subscription) {
    const payload = pushSubscriptionPayload(subscription);
    if (!payload.endpoint || !payload.keys.p256dh || !payload.keys.auth) {
      throw new Error('浏览器返回的 PushSubscription 不完整');
    }
    const response = await fetch('/mcpmonitor/api/push/subscription', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `通知订阅 HTTP ${response.status}`);
    }
    state.push.enabled = true;
    state.push.subscribed = true;
    safeStorageSet(NOTIFICATIONS_ENABLED_KEY, '1');
    await postServiceWorkerMessage({ type: 'enable-notifications' });
    updateNotificationButton();
  }

  async function syncPushSubscription({ requestPermission = false, create = false } = {}) {
    if (state.push.syncing || !state.authenticated) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      updateNotificationButton();
      return;
    }
    if (!requestPermission && safeStorageGet(NOTIFICATIONS_ENABLED_KEY) === '0') {
      state.push.enabled = false;
      state.push.subscribed = false;
      updateNotificationButton();
      return;
    }
    state.push.syncing = true;
    updateNotificationButton();
    try {
      if (requestPermission && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
      if (Notification.permission !== 'granted') {
        state.push.enabled = false;
        state.push.subscribed = false;
        safeStorageSet(NOTIFICATIONS_ENABLED_KEY, '0');
        updateNotificationButton();
        return;
      }
      if (!state.push.registration) {
        state.push.registration = await navigator.serviceWorker.register('/mcpmonitor/sw.js', {
          scope: '/mcpmonitor/',
        });
      }
      await navigator.serviceWorker.ready;
      const keyResponse = await fetch('/mcpmonitor/api/push/key', { cache: 'no-store' });
      if (!keyResponse.ok) throw new Error(`通知密钥 HTTP ${keyResponse.status}`);
      const key = await keyResponse.json();
      if (!key.enabled || !key.public_key) {
        state.push.enabled = false;
        state.push.subscribed = false;
        updateNotificationButton();
        return;
      }
      state.push.publicKey = key.public_key;
      let subscription = await state.push.registration.pushManager.getSubscription();
      if (!subscription) {
        if (!(create || state.push.enabled)) {
          state.push.subscribed = false;
          updateNotificationButton();
          return;
        }
        subscription = await state.push.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: pushPublicKeyBytes(key.public_key),
        });
      }
      await savePushSubscription(subscription);
      if (requestPermission) toast('系统通知已启用');
    } catch (error) {
      state.push.enabled = false;
      state.push.subscribed = false;
      if (requestPermission) safeStorageSet(NOTIFICATIONS_ENABLED_KEY, '0');
      updateNotificationButton();
      if (requestPermission) toast(error?.message || '系统通知启用失败');
    } finally {
      state.push.syncing = false;
      updateNotificationButton();
    }
  }

  async function disablePushSubscription({ preservePreference = false, silent = false } = {}) {
    if (state.push.syncing) return;
    state.push.syncing = true;
    updateNotificationButton();
    try {
      if (!state.push.registration && 'serviceWorker' in navigator) {
        state.push.registration = await navigator.serviceWorker.getRegistration('/mcpmonitor/');
      }
      const subscription = await state.push.registration?.pushManager?.getSubscription?.();
      if (subscription?.endpoint && state.authenticated) {
        await fetch('/mcpmonitor/api/push/subscription', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
          cache: 'no-store',
        }).catch(() => null);
      }
      if (subscription) await subscription.unsubscribe().catch(() => false);
      state.push.subscribed = false;
      if (!preservePreference) {
        state.push.enabled = false;
        safeStorageSet(NOTIFICATIONS_ENABLED_KEY, '0');
      } else {
        state.push.enabled = safeStorageGet(NOTIFICATIONS_ENABLED_KEY) === '1';
      }
      await postServiceWorkerMessage({ type: 'disable-notifications' });
      if (!silent && !preservePreference) toast('系统通知已关闭');
    } finally {
      state.push.syncing = false;
      updateNotificationButton();
    }
  }

  function userInputNotificationRequest(request) {
    const first = Array.isArray(request?.questions) ? request.questions[0] : null;
    return {
      type: 'user_input',
      id: request?.id,
      title: 'Codex 需要你的输入',
      body: first?.question || first?.title || '点击回答',
      url: `/mcpmonitor/?request=${encodeURIComponent(request?.id || '')}`,
    };
  }

  async function postServiceWorkerMessage(message) {
    try {
      if (!state.push.registration && 'serviceWorker' in navigator) {
        state.push.registration = await navigator.serviceWorker.getRegistration('/mcpmonitor/');
      }
      const worker =
        state.push.registration?.active ||
        state.push.registration?.waiting ||
        state.push.registration?.installing;
      worker?.postMessage(message);
    } catch {}
  }

  function openUserInputFromLink(id) {
    if (!id || !state.authenticated) return;
    const safe = String(id).slice(0, 128);
    selectCall(safe);
    const url = new URL(window.location.href);
    if (url.searchParams.has('request')) {
      url.searchParams.delete('request');
      history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
    }
  }

  function openPendingUserInputLink() {
    const id = new URLSearchParams(window.location.search).get('request');
    if (id) openUserInputFromLink(id);
  }

  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.add('hidden'), 1600);
  }

  function setBanner(message, visible = true) {
    $('banner').textContent = message || '';
    $('banner').classList.toggle('hidden', !visible || !message);
  }

  function renderConnection() {
    const online = state.connection === 'online';
    const offline = state.connection === 'offline';
    $('signal').className = `signal ${online ? 'online' : offline ? 'offline' : ''}`;
    $('connection-text').textContent = online ? '已连接' : offline ? '连接中断' : '正在连接';
    if (offline) setBanner(state.connectionMessage || '暂时无法连接 codex-mcp', true);
    else if (!$('banner').dataset.sticky) setBanner('', false);
  }

  function renderSidebar() {
    const collapsed = !!state.sidebarCollapsed;
    $('shell').classList.toggle('sidebar-collapsed', collapsed);
    const button = $('sidebar-reveal');
    button.setAttribute('aria-expanded', String(!collapsed));
  }

  function renderMainPane() {
    const collapsed = !!state.mainCollapsed;
    $('shell').classList.toggle('main-collapsed', collapsed);
    const button = $('main-toggle');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', '展开详情面板');
    button.title = '展开详情面板';
  }

  function mainPaneWouldCollapse(sidebarWidth, browserWidth) {
    if (state.mainCollapsed || !state.videoMonitor.open || logicalViewportWidth() <= 900)
      return false;
    const viewportWidth = Math.max(320, logicalViewportWidth());
    return (
      viewportWidth - Number(sidebarWidth || 0) - Number(browserWidth || 0) <=
      MAIN_AUTO_COLLAPSE_WIDTH
    );
  }

  function sidebarPanelLimits() {
    const viewportWidth = Math.max(320, logicalViewportWidth());
    if (viewportWidth <= 720) return { min: viewportWidth, max: viewportWidth };
    const min = Math.min(280, viewportWidth);
    if (state.mainCollapsed && state.videoMonitor.open) {
      // With the detail pane fully gone, the sidebar divider is the only
      // divider between the call list and Video Monitor.  Let it apportion
      // the whole row directly; do not reserve any phantom detail-pane width.
      const videoMin = Math.min(360, viewportWidth);
      return { min, max: Math.max(min, viewportWidth - videoMin) };
    }
    let browserWidth = 0;
    const browserPanel = $('browser-panel');
    // Above 900px the browser pane participates in the flex row. At tablet
    // widths an open browser pane is fixed/overlayed, so it must not reduce the
    // resize budget of the log pane. The collapsed browser rail remains in-flow.
    if (browserPanel && (viewportWidth > 900 || !state.videoMonitor.open)) {
      browserWidth = logicalElementWidth(browserPanel);
    }
    // Do not cap the list at an arbitrary desktop width.  Its right edge may
    // travel all the way toward Video Monitor; once the remaining detail gap
    // reaches MAIN_AUTO_COLLAPSE_WIDTH the detail pane disappears instead of
    // creating a non-responsive drag zone.
    const available = viewportWidth - browserWidth - MAIN_AUTO_COLLAPSE_WIDTH;
    const max = Math.max(min, available);
    return { min, max };
  }

  function applySidebarWidth(width, { persist = false } = {}) {
    const sidebar = $('sidebar');
    const resizer = $('sidebar-resizer');
    if (!sidebar || !resizer) return 0;
    const limits = sidebarPanelLimits();
    if (logicalViewportWidth() <= 720) {
      sidebar.style.removeProperty('--sidebar-width');
      resizer.removeAttribute('aria-valuenow');
      return logicalElementWidth(sidebar);
    }
    const fallback =
      logicalElementWidth(sidebar) || (logicalViewportWidth() <= 900 ? 300 : 330);
    const requested =
      Number.isFinite(Number(width)) && Number(width) > 0 ? Number(width) : fallback;
    const next = Math.round(Math.min(limits.max, Math.max(limits.min, requested)));
    state.sidebarWidth = next;
    sidebar.style.setProperty('--sidebar-width', `${next}px`);
    resizer.setAttribute('aria-valuemin', String(Math.round(limits.min)));
    resizer.setAttribute('aria-valuemax', String(Math.round(limits.max)));
    resizer.setAttribute('aria-valuenow', String(next));
    if (!state.mainCollapsed && state.videoMonitor.open && state.videoMonitor.panelWidth > 0)
      applyBrowserPanelWidth(state.videoMonitor.panelWidth);
    if (persist) persistPageState();
    requestAnimationFrame(renderAgentCursor);
    return next;
  }

  function setSidebarCollapsed(collapsed, { persist = true } = {}) {
    state.sidebarCollapsed = !!collapsed;
    renderSidebar();
    if (!state.sidebarCollapsed && state.sidebarWidth > 0) applySidebarWidth(state.sidebarWidth);
    if (state.videoMonitor.open && state.videoMonitor.panelWidth > 0)
      applyBrowserPanelWidth(state.videoMonitor.panelWidth);
    if (persist) persistPageState();
  }

  function setMainCollapsed(collapsed, { persist = true } = {}) {
    state.mainCollapsed = !!collapsed && logicalViewportWidth() > 720;
    if (state.mainCollapsed && !state.videoMonitor.open) {
      setVideoMonitorOpen(true, { persist: false });
    }
    renderMainPane();
    if (!state.mainCollapsed && state.videoMonitor.open && state.videoMonitor.panelWidth > 0) {
      applyBrowserPanelWidth(state.videoMonitor.panelWidth);
    }
    if (persist) persistPageState();
    requestAnimationFrame(renderAgentCursor);
  }



  function renderBrowser() {
    const browser = state.browser;
    const video = browser.video;
    const monitor = state.videoMonitor;
    const panel = $('browser-panel');
    panel.classList.toggle('collapsed', !monitor.open);
    $('browser-toggle').setAttribute('aria-expanded', String(monitor.open));

    const remoteStack = $('remote-stack');
    remoteStack.classList.toggle('browser-collapsed', !!browser.surfaceCollapsed);
    remoteStack.classList.toggle('native-collapsed', !!state.nativeLive.surfaceCollapsed);
    const browserStage = $('browser-stage');
    browserStage.classList.toggle('browser-surface-collapsed', !!browser.surfaceCollapsed);
    browserStage.classList.toggle('native-surface-collapsed', !!state.nativeLive.surfaceCollapsed);
    $('browser-surface-control-zone').setAttribute(
      'aria-hidden',
      String(!!browser.surfaceCollapsed),
    );
    $('native-surface-control-zone').setAttribute(
      'aria-hidden',
      String(!!state.nativeLive.surfaceCollapsed),
    );
    $('browser-surface').setAttribute('aria-hidden', String(!!browser.surfaceCollapsed));
    $('native-surface').setAttribute('aria-hidden', String(!!state.nativeLive.surfaceCollapsed));
    const browserMaximized = !browser.surfaceCollapsed && !!state.nativeLive.surfaceCollapsed;
    const nativeMaximized = !!browser.surfaceCollapsed && !state.nativeLive.surfaceCollapsed;
    $('browser-switch-surface').classList.toggle('hidden', !browserMaximized);
    $('native-switch-surface').classList.toggle('hidden', !nativeMaximized);
    const browserViewToggle = $('browser-view-toggle');
    browserViewToggle.classList.toggle('is-maximized', browserMaximized);
    browserViewToggle.title = browserMaximized ? '恢复 Browser + Native 双屏' : '最大化 Browser';
    browserViewToggle.setAttribute('aria-label', browserViewToggle.title);
    const nativeViewToggle = $('native-view-toggle');
    nativeViewToggle.classList.toggle('is-maximized', nativeMaximized);
    nativeViewToggle.title = nativeMaximized ? '恢复 Browser + Native 双屏' : '最大化 Native';
    nativeViewToggle.setAttribute('aria-label', nativeViewToggle.title);

    const audio = browser.audio;
    const audioButton = $('browser-audio-toggle');
    audioButton.setAttribute('aria-pressed', String(audio.enabled));
    audioButton.classList.toggle('audio-muted', !audio.enabled);
    audioButton.classList.toggle('audio-online', audio.enabled && audio.status === 'online');
    audioButton.classList.toggle(
      'audio-connecting',
      audio.enabled && audio.status === 'connecting',
    );
    audioButton.classList.toggle('audio-offline', audio.enabled && audio.status === 'offline');
    audioButton.title = '浏览器声音';

    const visualReady = video.status === 'online' && video.renderedFrames > 0;
    $('browser-placeholder').classList.toggle('hidden', visualReady);
    const native = state.nativeLive;
    const nativeReady = native.status === 'online' && native.renderer?.framesRendered > 0;
    $('native-placeholder').classList.toggle('hidden', nativeReady);
    const nativePlaceholderText = $('native-placeholder').querySelector('strong');
    if (nativePlaceholderText)
      nativePlaceholderText.textContent =
        native.status === 'offline'
          ? `Native: ${native.statusMessage || '连接失败'}`
          : '正在连接 Native';
    const nativeRelative = $('native-relative');
    if (nativeRelative) {
      const nativePointerLocked = document.pointerLockElement === $('native-surface');
      nativeRelative.disabled =
        !nativePointerLocked && (native.status !== 'online' || !nativeMaximized);
      nativeRelative.setAttribute('aria-pressed', String(nativePointerLocked));
      nativeRelative.title = nativePointerLocked
        ? '弹出鼠标 · Ctrl+Alt+Shift+Z'
        : nativeMaximized
          ? '捕获鼠标 · Ctrl+Alt+Shift+Z'
          : '仅在 Native 最大化时可捕获鼠标';
    }
    const browserSignal = $('browser-surface-signal');
    browserSignal.className = `surface-control-signal ${video.status === 'online' ? 'online' : video.status === 'connecting' ? 'connecting' : video.status === 'offline' ? 'offline' : ''}`;
    const nativeSignal = $('native-surface-signal');
    nativeSignal.className = `surface-control-signal ${native.status === 'online' ? 'online' : native.status === 'connecting' ? 'connecting' : native.status === 'offline' ? 'offline' : ''}`;
    requestAnimationFrame(syncSurfaceControlPositions);
    renderAgentCursor();
  }

  function surfaceControlParts(surface) {
    const browserSurface = surface === 'browser';
    return {
      zone: $(browserSurface ? 'browser-surface-control-zone' : 'native-surface-control-zone'),
      controls: $(browserSurface ? 'browser-surface-controls' : 'native-surface-controls'),
      model: browserSurface ? state.browser : state.nativeLive,
    };
  }

  function positionSurfaceControls(surface) {
    const { zone, controls, model } = surfaceControlParts(surface);
    if (!zone || !controls || zone.offsetParent === null) return;
    const position = model.controlPosition;
    if (!position) {
      controls.style.left = '';
      controls.style.top = '8px';
      controls.style.right = '8px';
      return;
    }
    const maxLeft = Math.max(0, zone.clientWidth - controls.offsetWidth);
    const maxTop = Math.max(0, zone.clientHeight - controls.offsetHeight);
    controls.style.right = 'auto';
    controls.style.left = `${Math.round(maxLeft * position.x)}px`;
    controls.style.top = `${Math.round(maxTop * position.y)}px`;
  }

  function syncSurfaceControlPositions() {
    positionSurfaceControls('browser');
    positionSurfaceControls('native');
  }

  function renderAgentCursor() {
    const cursor = $('browser-agent-cursor');
    const stage = $('browser-surface');
    if (!cursor || !stage) return;
    const pointer = state.browser.data?.agentPointer;
    const selectedTabId = state.browser.data?.selectedTabId ?? null;
    const x = Number(pointer?.x);
    const y = Number(pointer?.y);
    const matchesSelectedTab = !pointer?.tabId || !selectedTabId || pointer.tabId === selectedTabId;
    const visible =
      state.videoMonitor.open &&
      !state.browser.surfaceCollapsed &&
      pointer?.visible === true &&
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      matchesSelectedTab;
    if (!visible) {
      cursor.classList.remove('visible');
      return;
    }

    const rect = stage.getBoundingClientRect();
    const surface = fixedBrowserSurface();
    if (!rect.width || !rect.height || !surface.width || !surface.height) {
      cursor.classList.remove('visible');
      return;
    }
    // Agent actions use Playwright/page viewport coordinates while the Live
    // stream is the complete native Chromium window.  With the production
    // fixed app window the current renderer viewport is slightly shorter than
    // the 1920x1080 surface because native Chromium chrome occupies the top.
    // Keep that offset
    // explicit here instead of pretending page (0,0) is display (0,0).
    const viewport = state.browser.data?.viewport || surface;
    const viewportWidth = Math.max(
      1,
      Math.min(surface.width, Math.round(Number(viewport?.width || surface.width))),
    );
    const viewportHeight = Math.max(
      1,
      Math.min(surface.height, Math.round(Number(viewport?.height || surface.height))),
    );
    const viewportOffsetX = Math.max(0, (surface.width - viewportWidth) / 2);
    const viewportOffsetY = Math.max(0, surface.height - viewportHeight);
    const scale = Math.min(rect.width / surface.width, rect.height / surface.height);
    const renderedWidth = surface.width * scale;
    const renderedHeight = surface.height * scale;
    const left = (rect.width - renderedWidth) / 2;
    const top = (rect.height - renderedHeight) / 2;
    // The SVG is deliberately scaled around the original 13px/64px cursor
    // hotspot (104,104 in its 512x512 viewBox).  Keep the presentation hotspot
    // on that preserved click point; the far/right edge of the arrow is not
    // the pointer hotspot.
    const hotspotX = 13;
    const hotspotY = 13;
    const size = 64 * scale;
    const targetLeft = left + (viewportOffsetX + x - hotspotX) * scale;
    const targetTop = top + (viewportOffsetY + y - hotspotY) * scale;
    const uiScale = uiScaleFactor();
    const cursorState = state.browser.agentCursor;
    const previousLeft = cursorState.renderedX;
    const previousTop = cursorState.renderedY;
    const pointerChanged =
      cursorState.lastSeq !== pointer.seq ||
      cursorState.lastUpdatedAt !== pointer.updatedAt ||
      cursorState.lastAction !== pointer.action;
    const layoutChanged = cursorState.renderedSize !== size;

    cursor.style.width = `${size / uiScale}px`;
    cursor.style.height = `${size / uiScale}px`;
    cursor.style.setProperty('--agent-cursor-hotspot-x', `${(hotspotX * scale) / uiScale}px`);
    cursor.style.setProperty('--agent-cursor-hotspot-y', `${(hotspotY * scale) / uiScale}px`);

    let moveDuration = 0;
    if (
      pointerChanged &&
      Number.isFinite(previousLeft) &&
      Number.isFinite(previousTop) &&
      !layoutChanged
    ) {
      const distance = Math.hypot(targetLeft - previousLeft, targetTop - previousTop);
      if (distance >= 0.5) {
        // Animation timing is deliberately 100% local. Backend input has
        // already happened by the time this state arrives; the GUI simply
        // visualizes the semantic pointer event. Derive duration from the
        // unscaled surface distance so resizing the monitor does not change
        // perceived cursor speed.
        const surfaceDistance = distance / Math.max(scale, 0.001);
        const duration = Math.round(Math.max(45, Math.min(150, 38 + surfaceDistance * 0.12)));
        moveDuration = duration;
        cursor.style.setProperty('--agent-cursor-move-ms', `${duration}ms`);
        cursor.classList.add('moving');
        clearTimeout(cursorState.moveTimer);
        cursorState.moveTimer = setTimeout(() => cursor.classList.remove('moving'), duration + 20);
      }
    } else if (layoutChanged || !Number.isFinite(previousLeft) || !Number.isFinite(previousTop)) {
      clearTimeout(cursorState.moveTimer);
      cursor.classList.remove('moving');
    }
    cursor.style.left = `${targetLeft / uiScale}px`;
    cursor.style.top = `${targetTop / uiScale}px`;
    cursor.classList.add('visible');

    cursorState.renderedX = targetLeft;
    cursorState.renderedY = targetTop;
    cursorState.renderedSize = size;

    if (pointerChanged) {
      cursorState.lastSeq = pointer.seq;
      cursorState.lastUpdatedAt = pointer.updatedAt;
      cursorState.lastAction = pointer.action;
      const clickLike =
        /(^|-)click$|dblclick$|secondary-(activate|expand|collapse|check|uncheck|selectOption)$/.test(
          String(pointer.action || ''),
        );
      if (clickLike) {
        clearTimeout(cursorState.pulseTimer);
        clearTimeout(cursorState.pulseCleanupTimer);
        cursor.classList.remove('clicking');
        // Let the visible travel finish first, then press/release at the target.
        cursorState.pulseTimer = setTimeout(() => {
          cursor.classList.remove('clicking');
          // Restart the pulse even if two click actions arrive close together.
          void cursor.offsetWidth;
          cursor.classList.add('clicking');
          cursorState.pulseCleanupTimer = setTimeout(
            () => cursor.classList.remove('clicking'),
            240,
          );
        }, moveDuration);
      }
    }
  }

  function browserWsUrl() {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location.host}/mcpmonitor/browser/ws`;
  }

  function browserPanelLimits() {
    const viewportWidth = Math.max(320, logicalViewportWidth());
    if (viewportWidth <= 720) return { min: viewportWidth, max: viewportWidth };
    if (viewportWidth <= 900) return { min: Math.min(320, viewportWidth), max: viewportWidth };
    const sidebarWidth = logicalElementWidth($('sidebar'));
    const min = Math.min(360, viewportWidth);
    const max = Math.max(min, viewportWidth - sidebarWidth - MAIN_AUTO_COLLAPSE_WIDTH);
    return { min, max };
  }

  function applyBrowserPanelWidth(width, { persist = false } = {}) {
    const panel = $('browser-panel');
    const resizer = $('browser-resizer');
    if (!panel || !resizer) return 0;
    if (state.mainCollapsed && state.videoMonitor.open && logicalViewportWidth() > 720) {
      // In two-pane mode the video pane consumes everything the list pane does
      // not. Preserve the explicit video width for detail-pane restoration only.
      panel.style.removeProperty('--browser-panel-width');
      resizer.removeAttribute('aria-valuenow');
      return logicalElementWidth(panel);
    }
    const limits = browserPanelLimits();
    if (logicalViewportWidth() <= 720) {
      panel.style.removeProperty('--browser-panel-width');
      resizer.removeAttribute('aria-valuenow');
      return logicalViewportWidth();
    }
    const fallback = logicalElementWidth(panel) || 620;
    const requested =
      Number.isFinite(Number(width)) && Number(width) > 0 ? Number(width) : fallback;
    const next = Math.round(Math.min(limits.max, Math.max(limits.min, requested)));
    state.videoMonitor.panelWidth = next;
    panel.style.setProperty('--browser-panel-width', `${next}px`);
    resizer.setAttribute('aria-valuemin', String(Math.round(limits.min)));
    resizer.setAttribute('aria-valuemax', String(Math.round(limits.max)));
    resizer.setAttribute('aria-valuenow', String(next));
    if (persist) persistPageState();
    requestAnimationFrame(renderAgentCursor);
    return next;
  }

  function fixedBrowserSurface() {
    const surface = state.browser.data?.surface;
    const width = Math.round(Number(surface?.width || 1920));
    const height = Math.round(Number(surface?.height || 1080));
    return { width: width || 1920, height: height || 1080 };
  }

  function currentVideoViewport() {
    return fixedBrowserSurface();
  }

  function audioConnectionActive() {
    const audio = state.browser.audio;
    return !!(audio.pc || audio.connectPromise);
  }

  function ensureBrowserAudioContext() {
    const audio = state.browser.audio;
    if (audio.context) return audio.context;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error('Web Audio unavailable');
    audio.context = new Context({ latencyHint: 'interactive' });
    return audio.context;
  }

  function ensureBrowserAudioElement() {
    const audio = state.browser.audio;
    if (audio.element) return audio.element;
    const element = document.createElement('audio');
    element.autoplay = true;
    element.playsInline = true;
    element.preload = 'auto';
    element.muted = false;
    element.volume = 1;
    element.setAttribute('aria-hidden', 'true');
    element.style.display = 'none';
    document.body.appendChild(element);
    audio.element = element;
    return element;
  }

  function useNativeBrowserAudioElement() {
    // Chromium's native media-element sink is the canonical playout path for a
    // remote WebRTC track on desktop and also makes Edge expose the normal tab
    // audio indicator. Keep the existing Web Audio path on iOS/WebKit where it
    // is already known to work and where autoplay unlocking is more particular.
    const ua = navigator.userAgent || '';
    return /(?:Edg|Chrome|Chromium)\//.test(ua) && !/(?:EdgiOS|CriOS)\//.test(ua);
  }

  async function playBrowserAudioElement(stream) {
    const audio = state.browser.audio;
    const element = ensureBrowserAudioElement();
    if (element.srcObject !== stream) element.srcObject = stream;
    element.muted = false;
    element.volume = 1;
    await element.play();
    if (!audio.enabled || audio.stream !== stream) {
      element.pause();
      return;
    }
    try {
      audio.source?.disconnect();
    } catch {}
    audio.source = null;
    audio.status = 'online';
    audio.statusMessage = '已连接';
    renderBrowser();
  }

  function unlockBrowserAudio() {
    const audio = state.browser.audio;
    if (!audio.enabled) return;
    if (useNativeBrowserAudioElement() && audio.stream) {
      playBrowserAudioElement(audio.stream).catch((error) => {
        audio.status = error?.name === 'NotAllowedError' ? 'blocked' : 'offline';
        audio.statusMessage = error?.name === 'NotAllowedError' ? '待启用' : '不可用';
        renderBrowser();
      });
      return;
    }
    try {
      const context = ensureBrowserAudioContext();
      context
        .resume()
        .then(() => {
          if (!audio.enabled) return;
          if (audio.stream && !audio.source) attachBrowserAudioStream(audio.stream);
          if (audio.status === 'blocked') {
            audio.status = audio.stream ? 'online' : 'connecting';
            audio.statusMessage = audio.stream ? '已连接' : '正在连接';
            renderBrowser();
          }
        })
        .catch(() => {});
    } catch (error) {
      audio.status = 'offline';
      audio.statusMessage = '不可用';
      renderBrowser();
    }
  }

  function attachBrowserAudioStream(stream) {
    const audio = state.browser.audio;
    audio.stream = stream;
    if (!audio.enabled) return;
    if (useNativeBrowserAudioElement()) {
      playBrowserAudioElement(stream).catch((error) => {
        audio.status = error?.name === 'NotAllowedError' ? 'blocked' : 'offline';
        audio.statusMessage = error?.name === 'NotAllowedError' ? '待启用' : '不可用';
        renderBrowser();
      });
      return;
    }
    let context;
    try {
      context = ensureBrowserAudioContext();
    } catch (error) {
      failAudioConnection(error);
      return;
    }
    try {
      audio.source?.disconnect();
    } catch {}
    audio.source = null;
    try {
      const source = context.createMediaStreamSource(stream);
      source.connect(context.destination);
      audio.source = source;
      if (context.state === 'running') {
        audio.status = 'online';
        audio.statusMessage = '已连接';
      } else {
        audio.status = 'blocked';
        audio.statusMessage = '待启用';
      }
      renderBrowser();
    } catch (error) {
      failAudioConnection(error);
    }
  }

  function disconnectAudio({ keepStatus = false } = {}) {
    const audio = state.browser.audio;
    clearTimeout(audio.reconnectTimer);
    audio.reconnectTimer = null;
    clearTimeout(audio.disconnectTimer);
    audio.disconnectTimer = null;
    audio.generation += 1;
    try {
      audio.source?.disconnect();
    } catch {}
    audio.source = null;
    if (audio.element) {
      try {
        audio.element.pause();
      } catch {}
      try {
        audio.element.srcObject = null;
      } catch {}
    }
    audio.stream = null;
    try {
      audio.pc?.close();
    } catch {}
    audio.pc = null;
    audio.connectPromise = null;
    if (!keepStatus) {
      audio.status = audio.enabled ? 'idle' : 'muted';
      audio.statusMessage = audio.enabled ? '未连接' : '已关闭';
    }
    renderBrowser();
  }

  function scheduleAudioReconnect({ immediate = false } = {}) {
    const audio = state.browser.audio;
    if (!state.videoMonitor.open || !state.authenticated || !audio.enabled) return;
    clearTimeout(audio.reconnectTimer);
    audio.reconnectTimer = setTimeout(
      () => {
        audio.reconnectTimer = null;
        connectAudio();
      },
      immediate ? 0 : 500,
    );
  }

  function failAudioConnection(error, attempt = state.browser.audio.generation) {
    const audio = state.browser.audio;
    if (attempt !== audio.generation) return;
    disconnectAudio({ keepStatus: true });
    audio.status = 'offline';
    audio.statusMessage = '连接失败';
    renderBrowser();
    scheduleAudioReconnect();
  }

  function connectAudio() {
    const audio = state.browser.audio;
    if (
      !state.videoMonitor.open ||
      !state.authenticated ||
      !audio.enabled ||
      audioConnectionActive()
    )
      return;
    if (typeof RTCPeerConnection === 'undefined') {
      failAudioConnection(new Error('WebRTC audio unavailable'));
      return;
    }
    const attempt = audio.generation;
    audio.status = 'connecting';
    audio.statusMessage = '正在连接';
    renderBrowser();
    audio.connectPromise = (async () => {
      const pc = new RTCPeerConnection({ iceServers: [] });
      audio.pc = pc;
      const transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
      const capabilities = RTCRtpReceiver.getCapabilities?.('audio');
      const opus = (capabilities?.codecs || []).filter(
        (codec) => String(codec.mimeType || '').toLowerCase() === 'audio/opus',
      );
      if (opus.length && typeof transceiver.setCodecPreferences === 'function')
        transceiver.setCodecPreferences(opus);

      pc.addEventListener('track', (event) => {
        if (attempt !== audio.generation || audio.pc !== pc || event.track?.kind !== 'audio')
          return;
        const stream = event.streams?.[0] || new MediaStream([event.track]);
        attachBrowserAudioStream(stream);
      });
      pc.addEventListener('connectionstatechange', () => {
        if (attempt !== audio.generation || audio.pc !== pc) return;
        if (pc.connectionState === 'connected') {
          clearTimeout(audio.disconnectTimer);
          audio.disconnectTimer = null;
          return;
        }
        if (pc.connectionState === 'disconnected') {
          if (!audio.disconnectTimer) {
            audio.disconnectTimer = setTimeout(() => {
              audio.disconnectTimer = null;
              if (
                attempt === audio.generation &&
                audio.pc === pc &&
                pc.connectionState === 'disconnected'
              ) {
                failAudioConnection(new Error('RTC audio peer disconnected'), attempt);
              }
            }, 1800);
          }
          return;
        }
        if (['failed', 'closed'].includes(pc.connectionState)) {
          failAudioConnection(new Error(`RTC audio peer ${pc.connectionState}`), attempt);
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (pc.iceGatheringState !== 'complete') {
        await new Promise((resolve) => {
          const done = () => {
            if (pc.iceGatheringState !== 'complete') return;
            pc.removeEventListener('icegatheringstatechange', done);
            resolve();
          };
          pc.addEventListener('icegatheringstatechange', done);
          setTimeout(() => {
            pc.removeEventListener('icegatheringstatechange', done);
            resolve();
          }, 2500);
        });
      }
      if (attempt !== audio.generation || audio.pc !== pc) return;
      const response = await fetch('/mcpmonitor/browser/audio/rtc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sdp: pc.localDescription?.sdp || '' }),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`RTC audio signaling HTTP ${response.status}`);
      const answer = await response.json();
      if (!answer?.sdp) throw new Error('RTC audio answer missing');
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    })()
      .catch((error) => failAudioConnection(error, attempt))
      .finally(() => {
        if (attempt === audio.generation) audio.connectPromise = null;
      });
  }

  function videoConnectionActive() {
    const video = state.browser.video;
    return !!(video.rtcPc || video.reemoMainRenderer?.active || video.connectPromise);
  }





  function summarizeGaps(values) {
    if (!values.length)
      return { avg: null, p95: null, p99: null, max: null, over_12_5: 0, over_20: 0, over_30: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (p) =>
      sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
    return {
      avg: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)),
      p95: Number(percentile(0.95).toFixed(3)),
      p99: Number(percentile(0.99).toFixed(3)),
      max: Number(sorted[sorted.length - 1].toFixed(3)),
      over_12_5: values.filter((value) => value > 12.5).length,
      over_20: values.filter((value) => value > 20).length,
      over_30: values.filter((value) => value > 30).length,
    };
  }

  function stopReemoMainVideoRenderer(video) {
    const renderer = video?.reemoMainRenderer;
    if (!renderer) return;
    renderer.active = false;
    if (renderer.rafId) cancelAnimationFrame(renderer.rafId);
    if (renderer.reportTimer) clearInterval(renderer.reportTimer);
    if (renderer.visibilityHandler)
      document.removeEventListener('visibilitychange', renderer.visibilityHandler);
    if (renderer.focusHandler) window.removeEventListener('focus', renderer.focusHandler);
    try {
      renderer.decoder?.close();
    } catch {}
    try {
      renderer.dc?.close();
    } catch {}
    try {
      renderer.pc?.close();
    } catch {}
    try {
      for (const slot of renderer.texturesPool || []) {
        if (slot?.texture && renderer.gl) renderer.gl.deleteTexture(slot.texture);
      }
    } catch {}
    try {
      renderer.program && renderer.gl?.deleteProgram(renderer.program);
    } catch {}
    try {
      renderer.canvas?.remove();
    } catch {}
    if (video.rtcPc === renderer.pc) video.rtcPc = null;
    video.decoder = null;
    video.reemoMainRenderer = null;
  }

  function reemoCompileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'WebGL shader compile failed';
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function reemoCreateProgram(gl) {
    const vertexShader = reemoCompileShader(
      gl,
      gl.VERTEX_SHADER,
      `#version 300 es
      in vec2 a_position;
      in vec2 a_texcoord;
      out vec2 v_texcoord;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texcoord = a_texcoord;
      }
    `,
    );
    const fragmentShader = reemoCompileShader(
      gl,
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision mediump float;
      uniform sampler2D u_texture;
      in vec2 v_texcoord;
      out vec4 out_color;
      void main() {
        out_color = texture(u_texture, v_texcoord);
      }
    `,
    );
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || 'WebGL program link failed';
      gl.deleteProgram(program);
      throw new Error(message);
    }
    gl.useProgram(program);
    const vertices = new Float32Array([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
    const position = gl.getAttribLocation(program, 'a_position');
    const texcoord = gl.getAttribLocation(program, 'a_texcoord');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(texcoord);
    gl.vertexAttribPointer(
      texcoord,
      2,
      gl.FLOAT,
      false,
      stride,
      2 * Float32Array.BYTES_PER_ELEMENT,
    );
    return program;
  }

  async function connectVideoReemoMain(attempt) {
    const video = state.browser.video;
    if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') {
      throw new Error('WebCodecs AV1 unavailable');
    }
    const config = {
      codec: AV1_WEBCODECS_CODEC,
      codedWidth: 1920,
      codedHeight: 1080,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    };
    const supported = await VideoDecoder.isConfigSupported(config);
    if (!supported?.supported) throw new Error('WebCodecs AV1 config unsupported');
    if (attempt !== video.generation) return;

    stopReemoMainVideoRenderer(video);

    const inputLayer = $('browser-video-input');
    if (!inputLayer?.parentElement) throw new Error('Browser video surface unavailable');
    try {
      $('browser-video-reemo-main-canvas')?.remove();
    } catch {}
    const canvas = document.createElement('canvas');
    canvas.id = 'browser-video-reemo-main-canvas';
    canvas.className = 'browser-video browser-video-canvas';
    canvas.width = 1920;
    canvas.height = 1080;
    canvas.setAttribute('aria-hidden', 'true');
    inputLayer.parentElement.insertBefore(canvas, inputLayer);

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('Main-thread WebGL2 unavailable');
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    const program = reemoCreateProgram(gl);
    const textureUniform = gl.getUniformLocation(program, 'u_texture');
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    const texturePoolLength = 5;
    const texturesPool = [];
    for (let index = 0; index < texturePoolLength; index += 1) {
      const texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      texturesPool.push({
        index,
        texture,
        used: false,
        frameIndex: -1,
        frameTimestamp: null,
        decodedAt: null,
        receivedAt: null,
        frameId: null,
      });
    }
    // These context properties do not change during this renderer's lifetime.
    const glRenderer = gl.getParameter(gl.RENDERER);
    const glVersion = gl.getParameter(gl.VERSION);
    const renderer = {
      active: true,
      videoStreamingActive: true,
      serverVideoActive: null,
      rafStartDepth: 2,
      pllHighAgeMs: 24,
      pllHighPhaseMs: 12,
      pllSustainMs: 800,
      pllCooldownMs: 2000,
      pllHighSince: null,
      pllLastSlipAt: -Infinity,
      pllSlips: 0,
      lastReportedPllSlips: 0,
      pllPhaseBaseline: null,
      pllLastPhaseRelativeMs: null,
      pllLastOldestAgeMs: null,
      pllPhaseSamples: [],
      pllPhaseRelativeSamples: [],
      visibilityHandler: null,
      focusHandler: null,
      lastForegroundResetAt: -Infinity,
      foregroundResets: 0,
      lastReportedForegroundResets: 0,
      playoutStarted: false,
      playoutUnderflows: 0,
      presentationDrops: 0,
      startupDrops: 0,
      lastReportedPlayoutUnderflows: 0,
      lastReportedPresentationDrops: 0,
      canvas,
      gl,
      program,
      texturesPool,
      texturesStoreIndex: 0,
      texturesPlayIndex: 0,
      storedFrames: 0,
      playedFrames: 0,
      frameIndex: 0,
      pc: null,
      dc: null,
      dcAssembly: null,
      dcChunksReceived: 0,
      dcFramesAssembled: 0,
      dcIncompleteFrames: 0,
      lastReportedDcChunksReceived: 0,
      lastReportedDcFramesAssembled: 0,
      lastReportedDcIncompleteFrames: 0,
      decoder: null,
      rafId: 0,
      reportTimer: 0,
      firstPresented: false,
      framesReceived: 0,
      bytesReceived: 0,
      framesDecoded: 0,
      framesRendered: 0,
      rafDraws: 0,
      emptyDraws: 0,
      decodeErrors: 0,
      renderErrors: 0,
      lastReportedReceived: 0,
      lastReportedBytes: 0,
      lastReportedDecoded: 0,
      lastReportedRendered: 0,
      lastReportedRafDraws: 0,
      lastReportedEmptyDraws: 0,
      lastReportedDecodeErrors: 0,
      lastReportedRenderErrors: 0,
      lastReportAt: performance.now(),
      lastReceiveNow: null,
      lastDecodeNow: null,
      lastRenderNow: null,
      lastPts90k: null,
      timestampTicks: 0,
      lastFrameTimestamp: null,
      receiveGaps: [],
      decodeGaps: [],
      timestampGaps: [],
      decodeLatencies: [],
      uploadCpu: [],
      drawCpu: [],
      queueDelay: [],
      receiveToRender: [],
      renderGaps: [],
      pageRafFrames: 0,
      lastPageRafNow: null,
      pageRafGaps: [],
      poolDepthSamples: [],
      poolDepthMax: 0,
      decodeMeta: new Map(),
    };
    video.reemoMainRenderer = renderer;
    video.width = 1920;
    video.height = 1080;

    const poolDepth = () =>
      renderer.texturesPool.reduce((sum, slot) => sum + (slot.used ? 1 : 0), 0);
    const recordPoolDepth = () => {
      const depth = poolDepth();
      renderer.poolDepthSamples.push(depth);
      renderer.poolDepthMax = Math.max(renderer.poolDepthMax, depth);
      return depth;
    };

    const clearSlot = (slot) => {
      if (!slot) return;
      slot.used = false;
      slot.frameIndex = -1;
      slot.frameTimestamp = null;
      slot.decodedAt = null;
      slot.receivedAt = null;
      slot.frameId = null;
    };

    const dropOldest = (reason) => {
      for (let offset = 0; offset < texturePoolLength; offset += 1) {
        const index = (renderer.texturesPlayIndex + offset) % texturePoolLength;
        const slot = renderer.texturesPool[index];
        if (!slot.used) continue;
        renderer.texturesPlayIndex = (index + 1) % texturePoolLength;
        clearSlot(slot);
        renderer.presentationDrops += 1;
        if (reason === 'pll') renderer.pllSlips += 1;
        recordPoolDepth();
        return true;
      }
      return false;
    };

    const resetPlayoutAfterForeground = () => {
      if (!renderer.active || attempt !== video.generation) return;
      for (const slot of renderer.texturesPool) clearSlot(slot);
      renderer.texturesPlayIndex = renderer.texturesStoreIndex;
      renderer.playoutStarted = false;
      renderer.pllHighSince = null;
      renderer.pllLastSlipAt = -Infinity;
      renderer.pllPhaseBaseline = null;
      renderer.pllLastPhaseRelativeMs = null;
      renderer.pllLastOldestAgeMs = null;
      renderer.pllPhaseSamples = [];
      renderer.pllPhaseRelativeSamples = [];
      renderer.lastRenderNow = null;
      renderer.foregroundResets += 1;
      recordPoolDepth();
    };

    renderer.onStreamPause = () => {
      renderer.videoStreamingActive = false;
      renderer.dcAssembly = null;
      for (const slot of renderer.texturesPool) clearSlot(slot);
      renderer.texturesPlayIndex = renderer.texturesStoreIndex;
      renderer.playoutStarted = false;
      renderer.decodeMeta.clear();
    };
    renderer.onStreamResume = () => {
      renderer.dcAssembly = null;
      renderer.lastPts90k = null;
      renderer.timestampTicks = 0;
      renderer.lastReceiveNow = null;
      renderer.lastDecodeNow = null;
      renderer.decodeMeta.clear();
      resetPlayoutAfterForeground();
      renderer.videoStreamingActive = true;
    };

    renderer.visibilityHandler = () => {
      if (document.visibilityState === 'visible') resetPlayoutAfterForeground();
    };
    document.addEventListener('visibilitychange', renderer.visibilityHandler);

    const drawNext = () => {
      if (!renderer.active || attempt !== video.generation) return false;
      let slot = null;
      for (let offset = 0; offset < texturePoolLength; offset += 1) {
        const index = (renderer.texturesPlayIndex + offset) % texturePoolLength;
        if (renderer.texturesPool[index].used) {
          renderer.texturesPlayIndex = index;
          slot = renderer.texturesPool[index];
          break;
        }
      }
      if (!slot) {
        renderer.emptyDraws += 1;
        return false;
      }
      const now = performance.now();
      const startedAt = performance.now();
      try {
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0 + slot.index);
        gl.bindTexture(gl.TEXTURE_2D, slot.texture);
        gl.uniform1i(textureUniform, slot.index);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      } catch (error) {
        renderer.renderErrors += 1;
        throw error;
      }
      renderer.drawCpu.push(Math.max(0, performance.now() - startedAt));
      if (Number.isFinite(slot.decodedAt))
        renderer.queueDelay.push(Math.max(0, now - slot.decodedAt));
      if (Number.isFinite(slot.receivedAt))
        renderer.receiveToRender.push(Math.max(0, now - slot.receivedAt));
      if (Number.isFinite(renderer.lastRenderNow))
        renderer.renderGaps.push(Math.max(0, now - renderer.lastRenderNow));
      renderer.lastRenderNow = now;
      renderer.framesRendered += 1;
      renderer.playedFrames += 1;
      renderer.rafDraws += 1;
      clearSlot(slot);
      renderer.texturesPlayIndex = (renderer.texturesPlayIndex + 1) % texturePoolLength;
      recordPoolDepth();
      video.renderedFrames += 1;
      if (!renderer.firstPresented) {
        renderer.firstPresented = true;
        video.status = 'online';
        video.statusMessage = '已连接';
        renderBrowser();
      }
      return true;
    };

    const storeFrameInTexture = (frame, meta) => {
      let slot = renderer.texturesPool[renderer.texturesStoreIndex];
      if (slot.used) {
        dropOldest('overflow');
        slot = renderer.texturesPool[renderer.texturesStoreIndex];
      }
      const width = Math.max(1, Number(frame.displayWidth || frame.codedWidth || 1920));
      const height = Math.max(1, Number(frame.displayHeight || frame.codedHeight || 1080));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        video.width = width;
        video.height = height;
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      }
      const uploadStartedAt = performance.now();
      gl.activeTexture(gl.TEXTURE0 + slot.index);
      gl.bindTexture(gl.TEXTURE_2D, slot.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      renderer.uploadCpu.push(Math.max(0, performance.now() - uploadStartedAt));
      slot.used = true;
      slot.frameIndex = renderer.frameIndex++;
      slot.frameTimestamp = Number(frame.timestamp);
      slot.decodedAt = performance.now();
      slot.receivedAt = meta?.receivedAt ?? null;
      slot.frameId = meta?.frameId ?? null;
      renderer.texturesStoreIndex = (renderer.texturesStoreIndex + 1) % texturePoolLength;
      renderer.storedFrames += 1;
      recordPoolDepth();
    };

    const decoder = new VideoDecoder({
      output: (frame) => {
        if (!renderer.active || attempt !== video.generation) {
          try {
            frame.close();
          } catch {}
          return;
        }
        const now = performance.now();
        renderer.framesDecoded += 1;
        if (Number.isFinite(renderer.lastDecodeNow))
          renderer.decodeGaps.push(Math.max(0, now - renderer.lastDecodeNow));
        renderer.lastDecodeNow = now;
        const timestamp = Number(frame.timestamp);
        if (Number.isFinite(timestamp) && Number.isFinite(renderer.lastFrameTimestamp)) {
          renderer.timestampGaps.push(
            Math.max(0, (timestamp - renderer.lastFrameTimestamp) / 1000),
          );
        }
        if (Number.isFinite(timestamp)) renderer.lastFrameTimestamp = timestamp;
        const meta = renderer.decodeMeta.get(timestamp) || null;
        if (meta) {
          renderer.decodeLatencies.push(Math.max(0, now - meta.decodeSubmittedAt));
          renderer.decodeMeta.delete(timestamp);
        }
        try {
          storeFrameInTexture(frame, meta);
        } catch (error) {
          renderer.renderErrors += 1;
          failVideoConnection(error, attempt);
        } finally {
          try {
            frame.close();
          } catch {}
        }
      },
      error: (error) => {
        renderer.decodeErrors += 1;
        if (renderer.active && attempt === video.generation) failVideoConnection(error, attempt);
      },
    });
    decoder.configure(supported.config || config);
    renderer.decoder = decoder;
    video.decoder = decoder;

    const raf = (now) => {
      if (!renderer.active || attempt !== video.generation) return;
      renderer.pageRafFrames += 1;
      if (Number.isFinite(renderer.lastPageRafNow))
        renderer.pageRafGaps.push(Math.max(0, now - renderer.lastPageRafNow));
      renderer.lastPageRafNow = now;
      let depth = poolDepth();
      if (!renderer.playoutStarted && depth >= renderer.rafStartDepth) {
        renderer.playoutStarted = true;
      }
      if (renderer.playoutStarted) {
          if (depth > 1) {
            let oldest = null;
            for (let offset = 0; offset < texturePoolLength; offset += 1) {
              const index = (renderer.texturesPlayIndex + offset) % texturePoolLength;
              const candidate = renderer.texturesPool[index];
              if (candidate.used) {
                oldest = candidate;
                break;
              }
            }
            if (oldest) {
              const oldestAgeMs = Number.isFinite(oldest.decodedAt)
                ? Math.max(0, now - oldest.decodedAt)
                : null;
              const frameSourceMs = Number.isFinite(oldest.frameTimestamp)
                ? oldest.frameTimestamp / 1000
                : null;
              const phaseMs = Number.isFinite(frameSourceMs) ? now - frameSourceMs : null;
              if (Number.isFinite(phaseMs)) {
                if (
                  !Number.isFinite(renderer.pllPhaseBaseline) ||
                  phaseMs < renderer.pllPhaseBaseline
                ) {
                  renderer.pllPhaseBaseline = phaseMs;
                }
                const relative = phaseMs - renderer.pllPhaseBaseline;
                renderer.pllLastPhaseRelativeMs = relative;
                renderer.pllPhaseSamples.push({ now, phase: phaseMs });
                renderer.pllPhaseRelativeSamples.push(relative);
                if (renderer.pllPhaseSamples.length > 600) renderer.pllPhaseSamples.shift();
                if (renderer.pllPhaseRelativeSamples.length > 600)
                  renderer.pllPhaseRelativeSamples.shift();
              }
              renderer.pllLastOldestAgeMs = oldestAgeMs;
              const phaseHigh =
                Number.isFinite(renderer.pllLastPhaseRelativeMs) &&
                renderer.pllLastPhaseRelativeMs >= renderer.pllHighPhaseMs;
              const ageHigh = Number.isFinite(oldestAgeMs) && oldestAgeMs >= renderer.pllHighAgeMs;
              if (phaseHigh && ageHigh) {
                if (!Number.isFinite(renderer.pllHighSince)) renderer.pllHighSince = now;
                const sustained = now - renderer.pllHighSince >= renderer.pllSustainMs;
                const cooledDown = now - renderer.pllLastSlipAt >= renderer.pllCooldownMs;
                if (sustained && cooledDown && dropOldest('pll')) {
                  renderer.pllLastSlipAt = now;
                  renderer.pllHighSince = null;
                  depth = poolDepth();
                }
              } else {
                renderer.pllHighSince = null;
              }
            }
          }
          if (depth > 0) {
            try {
              drawNext();
            } catch (error) {
              failVideoConnection(error, attempt);
              return;
            }
          } else {
            renderer.playoutUnderflows += 1;
          }
      }
      renderer.rafId = requestAnimationFrame(raf);
    };
    renderer.rafId = requestAnimationFrame(raf);

    const submitEncodedFrame = (flags, frameId, pts90k, payload, receivedAt, wireBytes) => {
      if (!renderer.active || attempt !== video.generation) return;
      const now = Number.isFinite(receivedAt) ? receivedAt : performance.now();
      if (Number.isFinite(renderer.lastReceiveNow))
        renderer.receiveGaps.push(Math.max(0, now - renderer.lastReceiveNow));
      renderer.lastReceiveNow = now;
      renderer.framesReceived += 1;
      renderer.bytesReceived += Number(wireBytes || payload.byteLength || 0);
      if (renderer.lastPts90k === null) renderer.timestampTicks = 0;
      else {
        let ticks = (pts90k - renderer.lastPts90k) >>> 0;
        if (!ticks || ticks > 450000) ticks = 750;
        renderer.timestampTicks += ticks;
      }
      renderer.lastPts90k = pts90k;
      const timestampUs = Math.round((renderer.timestampTicks * 1000000) / 90000);
      const decodeSubmittedAt = performance.now();
      renderer.decodeMeta.set(timestampUs, { receivedAt: now, decodeSubmittedAt, frameId });
      while (renderer.decodeMeta.size > 512)
        renderer.decodeMeta.delete(renderer.decodeMeta.keys().next().value);
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: flags & 1 ? 'key' : 'delta',
            timestamp: timestampUs,
            duration: 8333,
            data: payload,
          }),
        );
      } catch (error) {
        renderer.decodeMeta.delete(timestampUs);
        renderer.decodeErrors += 1;
        failVideoConnection(error, attempt);
      }
    };

    if (typeof RTCPeerConnection === 'undefined') throw new Error('RTCDataChannel unavailable');
    const pc = new RTCPeerConnection({ iceServers: [] });
    const dc = pc.createDataChannel('video', { ordered: true });
    dc.binaryType = 'arraybuffer';
    renderer.pc = pc;
    renderer.dc = dc;
    video.rtcPc = pc;

    dc.addEventListener('message', (event) => {
      if (
        !renderer.active ||
        !renderer.videoStreamingActive ||
        attempt !== video.generation ||
        !(event.data instanceof ArrayBuffer)
      )
        return;
      const packet = new Uint8Array(event.data);
      if (
        packet.byteLength < 24 ||
        packet[0] !== 0x4d ||
        packet[1] !== 0x57 ||
        packet[2] !== 0x44 ||
        packet[3] !== 0x31
      )
        return;
      const view = new DataView(event.data);
      if (view.getUint16(6) !== 24) return;
      const flags = packet[4];
      const frameId = view.getUint32(8);
      const pts90k = view.getUint32(12);
      const chunkIndex = view.getUint16(16);
      const chunkCount = view.getUint16(18);
      const totalLen = view.getUint32(20);
      if (!chunkCount || chunkIndex >= chunkCount || !totalLen) return;
      const now = performance.now();
      renderer.dcChunksReceived += 1;
      // A complete single-message frame needs no assembly object or payload copy.
      if (chunkCount === 1 && !renderer.dcAssembly) {
        if (packet.byteLength - 24 !== totalLen) {
          renderer.dcIncompleteFrames += 1;
          return;
        }
        renderer.dcFramesAssembled += 1;
        submitEncodedFrame(flags, frameId, pts90k, packet.subarray(24), now, packet.byteLength);
        return;
      }
      let assembly = renderer.dcAssembly;
      if (!assembly || assembly.frameId !== frameId) {
        if (assembly && assembly.receivedChunks !== assembly.chunkCount)
          renderer.dcIncompleteFrames += 1;
        assembly = {
          frameId,
          flags,
          pts90k,
          chunkCount,
          totalLen,
          chunks: new Array(chunkCount),
          receivedChunks: 0,
          receivedBytes: 0,
          wireBytes: 0,
        };
        renderer.dcAssembly = assembly;
      }
      if (
        assembly.chunkCount !== chunkCount ||
        assembly.totalLen !== totalLen ||
        assembly.chunks[chunkIndex]
      )
        return;
      const chunk = packet.subarray(24);
      assembly.chunks[chunkIndex] = chunk;
      assembly.receivedChunks += 1;
      assembly.receivedBytes += chunk.byteLength;
      assembly.wireBytes += packet.byteLength;
      if (assembly.receivedChunks !== assembly.chunkCount) return;
      if (assembly.receivedBytes !== assembly.totalLen) {
        renderer.dcIncompleteFrames += 1;
        renderer.dcAssembly = null;
        return;
      }
      const payload = new Uint8Array(assembly.totalLen);
      let offset = 0;
      for (const part of assembly.chunks) {
        if (!part) {
          renderer.dcIncompleteFrames += 1;
          renderer.dcAssembly = null;
          return;
        }
        payload.set(part, offset);
        offset += part.byteLength;
      }
      renderer.dcFramesAssembled += 1;
      renderer.dcAssembly = null;
      submitEncodedFrame(
        assembly.flags,
        assembly.frameId,
        assembly.pts90k,
        payload,
        now,
        assembly.wireBytes,
      );
    });
    pc.addEventListener('connectionstatechange', () => {
      if (!renderer.active || attempt !== video.generation) return;
      if (pc.connectionState === 'connected') {
        clearTimeout(video.disconnectTimer);
        video.disconnectTimer = null;
        return;
      }
      if (pc.connectionState === 'disconnected') {
        if (!video.disconnectTimer) {
          video.disconnectTimer = setTimeout(() => {
            video.disconnectTimer = null;
            if (
              renderer.active &&
              attempt === video.generation &&
              video.rtcPc === pc &&
              pc.connectionState === 'disconnected'
            ) {
              failVideoConnection(new Error('Reemo DataChannel peer disconnected'), attempt);
            }
          }, 1800);
        }
        return;
      }
      if (['failed', 'closed'].includes(pc.connectionState)) {
        clearTimeout(video.disconnectTimer);
        video.disconnectTimer = null;
        failVideoConnection(new Error(`Reemo DataChannel peer ${pc.connectionState}`), attempt);
      }
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (pc.iceGatheringState !== 'complete') {
      await new Promise((resolve) => {
        const done = () => {
          if (pc.iceGatheringState !== 'complete') return;
          pc.removeEventListener('icegatheringstatechange', done);
          resolve();
        };
        pc.addEventListener('icegatheringstatechange', done);
        setTimeout(() => {
          pc.removeEventListener('icegatheringstatechange', done);
          resolve();
        }, 2500);
      });
    }
    if (!renderer.active || attempt !== video.generation) return;
    const response = await fetch('/mcpmonitor/browser/video/dc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sdp: pc.localDescription?.sdp || '' }),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Reemo DataChannel signaling HTTP ${response.status}`);
    const answer = await response.json();
    if (!answer?.sdp) throw new Error('Reemo DataChannel answer missing');
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    // Start the channel deadline only after signaling has completed. Mobile
    // networks can legitimately spend several seconds on ICE gathering/checks;
    // counting that time against a 3 s DataChannel deadline caused an endless
    // reconnect loop even though UDP connectivity was healthy.
    await new Promise((resolve, reject) => {
      if (dc.readyState === 'open') {
        resolve();
        return;
      }
      let timer = null;
      const finish = (error) => {
        if (timer !== null) clearTimeout(timer);
        dc.removeEventListener('open', opened);
        dc.removeEventListener('error', failed);
        dc.removeEventListener('close', failed);
        if (error) reject(error);
        else resolve();
      };
      const opened = () => finish();
      const failed = () => finish(new Error('Reemo DataChannel failed'));
      dc.addEventListener('open', opened, { once: true });
      dc.addEventListener('error', failed, { once: true });
      dc.addEventListener('close', failed, { once: true });
      timer = setTimeout(() => finish(new Error('Reemo DataChannel open timeout')), 10000);
      if (dc.readyState === 'open') opened();
      else if (dc.readyState === 'closed') failed();
    });
    if (!renderer.active || attempt !== video.generation) return;
    syncBrowserVideoStreaming({ force: true });

    if (!renderer.active || attempt !== video.generation) return;

    renderer.reportTimer = setInterval(() => {
      if (!renderer.active || attempt !== video.generation) return;
      const now = performance.now();
      const intervalMs = Math.max(1, now - renderer.lastReportAt);
      const received = renderer.framesReceived - renderer.lastReportedReceived;
      const bytes = renderer.bytesReceived - renderer.lastReportedBytes;
      const decoded = renderer.framesDecoded - renderer.lastReportedDecoded;
      const rendered = renderer.framesRendered - renderer.lastReportedRendered;
      const receiveGap = summarizeGaps(renderer.receiveGaps);
      const decodeGap = summarizeGaps(renderer.decodeGaps);
      const timestampGap = summarizeGaps(renderer.timestampGaps);
      const decodeLatency = summarizeGaps(renderer.decodeLatencies);
      const uploadCpu = summarizeGaps(renderer.uploadCpu);
      const drawCpu = summarizeGaps(renderer.drawCpu);
      const queueDelay = summarizeGaps(renderer.queueDelay);
      const receiveToRender = summarizeGaps(renderer.receiveToRender);
      const renderGap = summarizeGaps(renderer.renderGaps);
      const pageRafGap = summarizeGaps(renderer.pageRafGaps);
      const poolStats = summarizeGaps(renderer.poolDepthSamples);
      const pllPhaseRelative = summarizeGaps(renderer.pllPhaseRelativeSamples);
      let pllPhaseSlopePpm = null;
      if (renderer.pllPhaseSamples.length >= 8) {
        const samples = renderer.pllPhaseSamples;
        const meanNow = samples.reduce((sum, sample) => sum + sample.now, 0) / samples.length;
        const meanPhase = samples.reduce((sum, sample) => sum + sample.phase, 0) / samples.length;
        let covariance = 0;
        let variance = 0;
        for (const sample of samples) {
          const dx = sample.now - meanNow;
          covariance += dx * (sample.phase - meanPhase);
          variance += dx * dx;
        }
        if (variance > 0)
          pllPhaseSlopePpm = Number(((covariance / variance) * 1_000_000).toFixed(3));
      }
      const report = {
        backend: 'reemo-main-dc-pll-av1',
        renderer_mode: 'reemo-dc-pll',
        transport: 'rtcdatachannel',
        codec: AV1_WEBCODECS_CODEC,
        frames_per_second: Number(((received * 1000) / intervalMs).toFixed(3)),
        frames_received: received,
        frames_decoded: decoded,
        rendered_frames: rendered,
        receive_mbps: Number(((bytes * 8) / (intervalMs * 1000)).toFixed(3)),
        ws_receive_gap_avg_ms: receiveGap.avg,
        ws_receive_gap_p95_ms: receiveGap.p95,
        ws_receive_gap_p99_ms: receiveGap.p99,
        ws_receive_gap_max_ms: receiveGap.max,
        transport_receive_gap_avg_ms: receiveGap.avg,
        transport_receive_gap_p95_ms: receiveGap.p95,
        transport_receive_gap_p99_ms: receiveGap.p99,
        transport_receive_gap_max_ms: receiveGap.max,
        decode_output_gap_avg_ms: decodeGap.avg,
        decode_output_gap_p95_ms: decodeGap.p95,
        decode_output_gap_p99_ms: decodeGap.p99,
        decode_output_gap_max_ms: decodeGap.max,
        timestamp_gap_avg_ms: timestampGap.avg,
        timestamp_gap_p95_ms: timestampGap.p95,
        timestamp_gap_p99_ms: timestampGap.p99,
        decode_submit_to_output_avg_ms: decodeLatency.avg,
        decode_submit_to_output_p95_ms: decodeLatency.p95,
        decode_submit_to_output_p99_ms: decodeLatency.p99,
        texture_upload_avg_ms: uploadCpu.avg,
        texture_upload_p95_ms: uploadCpu.p95,
        texture_upload_p99_ms: uploadCpu.p99,
        draw_cpu_avg_ms: drawCpu.avg,
        draw_cpu_p95_ms: drawCpu.p95,
        draw_cpu_p99_ms: drawCpu.p99,
        frame_queue_delay_avg_ms: queueDelay.avg,
        frame_queue_delay_p95_ms: queueDelay.p95,
        frame_queue_delay_p99_ms: queueDelay.p99,
        receive_to_render_avg_ms: receiveToRender.avg,
        receive_to_render_p95_ms: receiveToRender.p95,
        receive_to_render_p99_ms: receiveToRender.p99,
        render_gap_avg_ms: renderGap.avg,
        render_gap_p95_ms: renderGap.p95,
        render_gap_p99_ms: renderGap.p99,
        render_gap_max_ms: renderGap.max,
        page_raf_frames: renderer.pageRafFrames,
        page_raf_gap_avg_ms: pageRafGap.avg,
        page_raf_gap_p95_ms: pageRafGap.p95,
        page_raf_gap_p99_ms: pageRafGap.p99,
        pool_depth: poolDepth(),
        pool_depth_avg: poolStats.avg,
        pool_depth_p95: poolStats.p95,
        pool_depth_max: renderer.poolDepthMax,
        pool_length: texturePoolLength,
        raf_playout: true,
        raf_start_depth: renderer.rafStartDepth,
        pll_enabled: true,
        pll_high_age_ms: renderer.pllHighAgeMs,
        pll_high_phase_ms: renderer.pllHighPhaseMs,
        pll_sustain_ms: renderer.pllSustainMs,
        pll_cooldown_ms: renderer.pllCooldownMs,
        pll_oldest_age_ms: renderer.pllLastOldestAgeMs,
        pll_phase_relative_ms: renderer.pllLastPhaseRelativeMs,
        pll_phase_relative_avg_ms: pllPhaseRelative.avg,
        pll_phase_relative_p95_ms: pllPhaseRelative.p95,
        pll_phase_relative_max_ms: pllPhaseRelative.max,
        pll_phase_slope_ppm: pllPhaseSlopePpm,
        pll_high_active_ms: Number.isFinite(renderer.pllHighSince)
          ? Math.max(0, now - renderer.pllHighSince)
          : 0,
        pll_slips: renderer.pllSlips - renderer.lastReportedPllSlips,
        pll_slips_total: renderer.pllSlips,
        foreground_resets: renderer.foregroundResets - renderer.lastReportedForegroundResets,
        foreground_resets_total: renderer.foregroundResets,
        playout_started: renderer.playoutStarted,
        playout_underflows: renderer.playoutUnderflows - renderer.lastReportedPlayoutUnderflows,
        presentation_drops: renderer.presentationDrops - renderer.lastReportedPresentationDrops,
        raf_draws: renderer.rafDraws - renderer.lastReportedRafDraws,
        empty_draws: renderer.emptyDraws - renderer.lastReportedEmptyDraws,
        decode_errors: renderer.decodeErrors - renderer.lastReportedDecodeErrors,
        render_errors: renderer.renderErrors - renderer.lastReportedRenderErrors,
        decoder_queue_size: decoder.decodeQueueSize,
        dc_chunks_received: renderer.dcChunksReceived - renderer.lastReportedDcChunksReceived,
        dc_frames_assembled: renderer.dcFramesAssembled - renderer.lastReportedDcFramesAssembled,
        dc_incomplete_frames: renderer.dcIncompleteFrames - renderer.lastReportedDcIncompleteFrames,
        rtc_connection_state: renderer.pc?.connectionState ?? null,
        dc_ready_state: renderer.dc?.readyState ?? null,
        dc_buffered_amount: Number(renderer.dc?.bufferedAmount ?? 0),
        sctp_max_message_size: Number(renderer.pc?.sctp?.maxMessageSize ?? 0) || null,
        gl_finish: false,
        gl_renderer: glRenderer,
        gl_version: glVersion,
        document_visibility: document.visibilityState,
      };
      fetch('/mcpmonitor/api/video-telemetry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
        cache: 'no-store',
        keepalive: true,
      }).catch(() => {});
      renderer.lastReportedReceived = renderer.framesReceived;
      renderer.lastReportedBytes = renderer.bytesReceived;
      renderer.lastReportedDecoded = renderer.framesDecoded;
      renderer.lastReportedRendered = renderer.framesRendered;
      renderer.lastReportedRafDraws = renderer.rafDraws;
      renderer.lastReportedEmptyDraws = renderer.emptyDraws;
      renderer.lastReportedDecodeErrors = renderer.decodeErrors;
      renderer.lastReportedRenderErrors = renderer.renderErrors;
      renderer.lastReportedDcChunksReceived = renderer.dcChunksReceived;
      renderer.lastReportedDcFramesAssembled = renderer.dcFramesAssembled;
      renderer.lastReportedDcIncompleteFrames = renderer.dcIncompleteFrames;
      renderer.lastReportedPlayoutUnderflows = renderer.playoutUnderflows;
      renderer.lastReportedPresentationDrops = renderer.presentationDrops;
      renderer.lastReportedPllSlips = renderer.pllSlips;
      renderer.lastReportedForegroundResets = renderer.foregroundResets;
      renderer.lastReportAt = now;
      renderer.receiveGaps = [];
      renderer.decodeGaps = [];
      renderer.timestampGaps = [];
      renderer.decodeLatencies = [];
      renderer.uploadCpu = [];
      renderer.drawCpu = [];
      renderer.queueDelay = [];
      renderer.receiveToRender = [];
      renderer.renderGaps = [];
      renderer.pageRafFrames = 0;
      renderer.pageRafGaps = [];
      renderer.poolDepthSamples = [];
      renderer.poolDepthMax = poolDepth();
    }, 1000);

    renderer.dc?.addEventListener(
      'close',
      () => {
        if (renderer.active && attempt === video.generation) {
          failVideoConnection(new Error('Reemo main video datachannel closed'), attempt);
        }
      },
      { once: true },
    );
  }

  function disconnectVideo({ keepStatus = false } = {}) {
    const video = state.browser.video;
    stopReemoMainVideoRenderer(video);
    clearTimeout(video.reconnectTimer);
    video.reconnectTimer = null;
    clearTimeout(video.disconnectTimer);
    video.disconnectTimer = null;
    video.generation += 1;
    try {
      video.rtcPc?.close();
    } catch {}
    video.rtcPc = null;
    video.connectPromise = null;
    video.width = 0;
    video.height = 0;
    video.renderedFrames = 0;
    if (!keepStatus) {
      video.status = 'idle';
      video.statusMessage = '未连接';
    }
    renderBrowser();
  }

  function scheduleVideoReconnect({ immediate = false } = {}) {
    const video = state.browser.video;
    if (
      !state.videoMonitor.open ||
      !state.authenticated ||
      document.visibilityState === 'hidden'
    )
      return;
    clearTimeout(video.reconnectTimer);
    video.reconnectTimer = setTimeout(
      () => {
        video.reconnectTimer = null;
        if (document.visibilityState === 'hidden') return;
        connectVideo();
      },
      immediate ? 0 : 220,
    );
  }

  function failVideoConnection(error, attempt = state.browser.video.generation) {
    const video = state.browser.video;
    if (attempt !== video.generation) return;
    disconnectVideo({ keepStatus: true });
    video.status = 'offline';
    video.statusMessage = '连接失败';
    renderBrowser();
    scheduleVideoReconnect();
  }




  function connectVideo() {
    const browser = state.browser;
    const video = browser.video;
    if (
      !state.videoMonitor.open ||
      !state.authenticated ||
      document.visibilityState === 'hidden'
    )
      return;
    if (videoConnectionActive()) return;
    const attempt = video.generation;
    video.status = 'connecting';
    video.statusMessage = '正在连接';
    renderBrowser();
    video.connectPromise = connectVideoReemoMain(attempt)
      .catch((error) => failVideoConnection(error, attempt))
      .finally(() => {
        if (attempt === video.generation) video.connectPromise = null;
      });
  }

  function nativeConnectionActive() {
    const native = state.nativeLive;
    if (native.connectPromise) return true;
    if (!native.pc) return false;
    return !['failed', 'closed'].includes(native.pc.connectionState);
  }

  function nativeCanSend() {
    const native = state.nativeLive;
    return native.dc?.readyState === 'open';
  }

  function nativeSend(message) {
    if (!nativeCanSend()) return false;
    const dc = state.nativeLive.dc;
    // Pointer motion is state, not an RPC. If the reliable input stream has
    // started queueing, the newest future motion supersedes this one. Dropping
    // stale motion prevents mouse activity from consuming SCTP cwnd needed by
    // the realtime video stream. Key/button/reset/snapshot messages remain
    // reliable and are never dropped here.
    if (['m', 'mr'].includes(message?.t) && Number(dc?.bufferedAmount || 0) > 4 * 1024)
      return false;
    const payload = JSON.stringify(message);
    try {
      dc.send(payload);
      return true;
    } catch {
      return false;
    }
  }

  function browserVideoShouldStream() {
    return (
      state.videoMonitor.open &&
      state.authenticated &&
      document.visibilityState === 'visible' &&
      !state.browser.surfaceCollapsed
    );
  }

  function nativeVideoShouldStream() {
    return (
      state.videoMonitor.open &&
      state.authenticated &&
      document.visibilityState === 'visible' &&
      !state.nativeLive.surfaceCollapsed
    );
  }

  function syncBrowserVideoStreaming({ force = false } = {}) {
    const renderer = state.browser.video.reemoMainRenderer;
    const dc = renderer?.dc;
    if (!renderer || dc?.readyState !== 'open') return false;
    const active = browserVideoShouldStream();
    if (!force && renderer.serverVideoActive === active) return true;
    if (active) renderer.onStreamResume?.();
    else renderer.onStreamPause?.();
    try {
      dc.send(active ? 'video:on' : 'video:off');
      renderer.serverVideoActive = active;
      return true;
    } catch {
      return false;
    }
  }

  function syncNativeVideoStreaming({ force = false } = {}) {
    const native = state.nativeLive;
    const renderer = native.renderer;
    const dc = native.dc;
    if (!renderer || dc?.readyState !== 'open') return false;
    const active = nativeVideoShouldStream();
    if (!force && renderer.serverVideoActive === active) return true;
    if (active) renderer.onStreamResume?.();
    else renderer.onStreamPause?.();
    try {
      dc.send(active ? 'video:on' : 'video:off');
      renderer.serverVideoActive = active;
      return true;
    } catch {
      return false;
    }
  }

  function syncVideoStreaming({ force = false } = {}) {
    syncBrowserVideoStreaming({ force });
    syncNativeVideoStreaming({ force });
  }

  const NATIVE_CURSOR_ALIASES = new Map(
    Object.entries({
      left_ptr: 'default',
      arrow: 'default',
      xterm: 'text',
      ibeam: 'text',
      hand: 'pointer',
      hand1: 'pointer',
      hand2: 'pointer',
      pointing_hand: 'pointer',
      size_hor: 'ew-resize',
      size_ver: 'ns-resize',
      size_bdiag: 'nesw-resize',
      size_fdiag: 'nwse-resize',
      fleur: 'move',
      forbidden: 'not-allowed',
      watch: 'wait',
      left_ptr_watch: 'progress',
      openhand: 'grab',
      closedhand: 'grabbing',
    }),
  );
  const NATIVE_CSS_CURSORS = new Set([
    'default',
    'pointer',
    'text',
    'crosshair',
    'move',
    'wait',
    'progress',
    'help',
    'not-allowed',
    'grab',
    'grabbing',
    'ew-resize',
    'ns-resize',
    'nesw-resize',
    'nwse-resize',
    'n-resize',
    's-resize',
    'e-resize',
    'w-resize',
    'col-resize',
    'row-resize',
  ]);
  function nativeCursorCss(shape) {
    shape = String(shape || 'default').toLowerCase();
    shape = NATIVE_CURSOR_ALIASES.get(shape) || shape.replaceAll('_', '-');
    return NATIVE_CSS_CURSORS.has(shape) ? shape : 'default';
  }
  function renderNativeCursorOverlay() {
    const native = state.nativeLive;
    const surface = $('native-surface');
    const overlay = $('native-cursor-overlay');
    if (!surface || !overlay) return;
    const cursor = native.cursor || {};
    const visible = cursor.visible === true && native.status !== 'offline';
    const locked = document.pointerLockElement === surface;
    surface.style.cursor = visible && !locked ? nativeCursorCss(cursor.shape) : 'none';
    overlay.classList.toggle('visible', visible && locked);
    if (!visible || !locked) return;
    const content = nativeContentRect();
    const surfaceRect = surface.getBoundingClientRect();
    const x =
      content.left -
      surfaceRect.left +
      (Math.max(0, Math.min(content.vw - 1, Number(cursor.x || 0))) * content.width) / content.vw;
    const y =
      content.top -
      surfaceRect.top +
      (Math.max(0, Math.min(content.vh - 1, Number(cursor.y || 0))) * content.height) / content.vh;
    const scale = uiScaleFactor();
    overlay.style.left = `${x / scale}px`;
    overlay.style.top = `${y / scale}px`;
  }
  function handleNativeCursorMessage(event) {
    if (typeof event?.data !== 'string') return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.t !== 'cursor') return;
    state.nativeLive.cursor = {
      t: 'cursor',
      x: Number(message.x || 0),
      y: Number(message.y || 0),
      visible: message.visible === true,
      shape: String(message.shape || 'default'),
      hotspotX: Number(message.hotspotX || 0),
      hotspotY: Number(message.hotspotY || 0),
    };
    renderNativeCursorOverlay();
  }

  function releaseNativeInput() {
    const native = state.nativeLive;
    for (const code of native.pressedKeys) nativeSend({ t: 'k', code, down: false });
    native.pressedKeys.clear();
    nativeSend({ t: 'reset' });
  }

  function stopNativePllRenderer(native) {
    const renderer = native?.renderer;
    if (!renderer) return;
    renderer.active = false;
    if (renderer.rafId) cancelAnimationFrame(renderer.rafId);
    if (renderer.reportTimer) clearInterval(renderer.reportTimer);
    if (renderer.stallTimer) clearTimeout(renderer.stallTimer);
    renderer.stallTimer = 0;
    if (renderer.visibilityHandler)
      document.removeEventListener('visibilitychange', renderer.visibilityHandler);
    if (renderer.focusHandler) window.removeEventListener('focus', renderer.focusHandler);
    try {
      renderer.decoder?.close();
    } catch {}
    try {
      renderer.videoDc?.close();
    } catch {}
    try {
      renderer.inputDc?.close();
    } catch {}
    try {
      renderer.pc?.close();
    } catch {}
    try {
      for (const slot of renderer.texturesPool || []) {
        if (slot?.texture && renderer.gl) renderer.gl.deleteTexture(slot.texture);
      }
    } catch {}
    try {
      renderer.program && renderer.gl?.deleteProgram(renderer.program);
    } catch {}
    try {
      renderer.canvas?.remove();
    } catch {}
    native.renderer = null;
  }

  function disconnectNativeLive({ keepStatus = false } = {}) {
    const native = state.nativeLive;
    clearTimeout(native.reconnectTimer);
    clearTimeout(native.disconnectTimer);
    native.reconnectTimer = null;
    native.disconnectTimer = null;
    native.generation += 1;
    releaseNativeInput();
    if (native.motionRaf) cancelAnimationFrame(native.motionRaf);
    native.motionRaf = 0;
    native.pendingMotion = null;
    stopNativePllRenderer(native);
    try {
      native.dc?.close();
    } catch {}
    try {
      native.pc?.close();
    } catch {}
    native.dc = null;
    native.pc = null;
    native.connectPromise = null;
    native.pointerId = null;
    native.cursor = {
      t: 'cursor',
      x: 0,
      y: 0,
      visible: false,
      shape: 'default',
      hotspotX: 0,
      hotspotY: 0,
    };
    renderNativeCursorOverlay();
    if (!keepStatus) {
      native.status = 'idle';
      native.statusMessage = '未连接';
    }
    renderBrowser();
  }

  function scheduleNativeReconnect({ immediate = false } = {}) {
    const native = state.nativeLive;
    if (!state.videoMonitor.open || !state.authenticated || native.reconnectTimer) return;
    native.reconnectTimer = setTimeout(
      () => {
        native.reconnectTimer = null;
        connectNativeLive();
      },
      immediate ? 0 : 350,
    );
  }

  async function waitRtcIce(pc, timeout = 2500) {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise((resolve) => {
      let timer = 0;
      const finish = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', done);
        resolve();
      };
      const done = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      timer = setTimeout(finish, timeout);
      pc.addEventListener('icegatheringstatechange', done);
    });
  }

  function failNativeLiveConnection(error, attempt) {
    const native = state.nativeLive;
    if (attempt !== native.generation) return;
    disconnectNativeLive({ keepStatus: true });
    native.status = 'offline';
    native.statusMessage = String(error?.message || error || '连接失败');
    console.warn('Native stream failed', error);
    renderBrowser();
    scheduleNativeReconnect();
  }

  async function connectNativeLiveVfr(attempt) {
    const native = state.nativeLive;
    let health = null;
    if (native.health && Date.now() - native.healthFetchedAt < 30000) {
      health = native.health;
    } else {
      const healthResponse = await fetch('/mcpmonitor/native/health', { cache: 'no-store' });
      if (!healthResponse.ok) throw new Error(`Native Live health HTTP ${healthResponse.status}`);
      health = await healthResponse.json();
      native.healthFetchedAt = Date.now();
    }
    if (attempt !== native.generation) return;
    native.health = health;
    native.width = Math.max(1, Number(health.width || 1920));
    native.height = Math.max(1, Number(health.height || 1080));
    native.fps = Math.max(1, Number(health.fps || 120));
    native.codec = String(health.selected_codec || 'av1').toLowerCase();
    if (native.codec !== 'av1') throw new Error('Native VFR requires AV1');
    if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') {
      throw new Error('Native VFR requires WebCodecs');
    }
    if (typeof RTCPeerConnection !== 'function') {
      throw new Error('Native DC+VFR requires RTCDataChannel');
    }

    const config = {
      codec: AV1_WEBCODECS_CODEC,
      codedWidth: native.width,
      codedHeight: native.height,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    };
    let supported = await VideoDecoder.isConfigSupported(config);
    // Some Linux Chromium builds expose WebCodecs but no hardware AV1
    // decoder. Keep the same AV1 bitstream and full geometry/rate; only the
    // decoding implementation may fall back, never the streaming profile.
    if (!supported?.supported) {
      config.hardwareAcceleration = 'no-preference';
      supported = await VideoDecoder.isConfigSupported(config);
    }
    if (!supported?.supported) throw new Error('Native WebCodecs AV1 config unsupported');
    if (attempt !== native.generation) return;

    stopNativePllRenderer(native);
    const surface = $('native-surface');
    const placeholder = $('native-placeholder');
    if (!surface || !placeholder) throw new Error('Native video surface unavailable');
    try {
      $('native-video-dc-pll-canvas')?.remove();
    } catch {}
    const canvas = document.createElement('canvas');
    canvas.id = 'native-video-dc-pll-canvas';
    canvas.className = 'native-video';
    canvas.width = native.width;
    canvas.height = native.height;
    canvas.setAttribute('aria-hidden', 'true');
    surface.insertBefore(canvas, placeholder);

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      // This renderer schedules by display rAF. Bypassing the browser
      // compositor starves that feedback on some platforms (120 decoded,
      // but only 30 rAF/draws per second in the integration test).
      desynchronized: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('Native main-thread WebGL2 unavailable');
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    const program = reemoCreateProgram(gl);
    const textureUniform = gl.getUniformLocation(program, 'u_texture');
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    const texturePoolLength = 5;
    const texturesPool = [];
    for (let index = 0; index < texturePoolLength; index += 1) {
      const texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      texturesPool.push({
        index,
        texture,
        used: false,
        frameTimestamp: null,
        decodedAt: null,
        receivedAt: null,
      });
    }

    const renderer = {
      active: true,
      videoStreamingActive: true,
      serverVideoActive: null,
      canvas,
      gl,
      program,
      texturesPool,
      storeIndex: 0,
      playIndex: 0,
      pc: null,
      videoDc: null,
      inputDc: null,
      decoder: null,
      assembly: null,
      rafId: 0,
      reportTimer: 0,
      stallTimer: 0,
      stallTimeoutMs:
        Number(health.idle_fps) > 0
          ? Math.max(5000, Math.ceil(4000 / Number(health.idle_fps)))
          : 0,
      videoProgressAt: performance.now(),
      visibilityHandler: null,
      focusHandler: null,
      lastForegroundResetAt: -Infinity,
      playoutStarted: false,
      vfrTargetDelayMs: 6,
      vfrBasePtsUs: null,
      vfrBaseLocalMs: null,
      vfrClockCorrectionMs: 0,
      vfrClockErrorEwmaMs: 0,
      vfrClockSamples: 0,
      vfrClockRebases: 0,
      vfrLastClockRebaseReason: null,
      vfrTargetSourceUs: null,
      vfrLatestSubmittedTimestampUs: null,
      vfrLastPresentedTimestampUs: null,
      vfrDropBeforeTimestampUs: null,
      vfrHolds: 0,
      vfrLateDrops: 0,
      vfrStaleDecodedDrops: 0,
      vfrPresentationLateness: [],
      framesReceived: 0,
      framesDecoded: 0,
      framesRendered: 0,
      bytesReceived: 0,
      dcChunksReceived: 0,
      dcFramesAssembled: 0,
      dcIncompleteFrames: 0,
      decodeErrors: 0,
      renderErrors: 0,
      playoutUnderflows: 0,
      presentationDrops: 0,
      startupDrops: 0,
      pllSlips: 0,
      foregroundResets: 0,
      lastReportedReceived: 0,
      lastReportedDecoded: 0,
      lastReportedRendered: 0,
      lastReportedBytes: 0,
      lastReportedChunks: 0,
      lastReportedAssembled: 0,
      lastReportedIncomplete: 0,
      lastReportedUnderflows: 0,
      lastReportedDrops: 0,
      lastReportedStartupDrops: 0,
      lastReportedPllSlips: 0,
      lastReportedForegroundResets: 0,
      lastReportedVfrHolds: 0,
      lastReportedVfrLateDrops: 0,
      lastReportedVfrStaleDecodedDrops: 0,
      lastReportedVfrClockRebases: 0,
      lastReportAt: performance.now(),
      lastReceiveNow: null,
      lastDecodeNow: null,
      lastRenderNow: null,
      lastPageRafNow: null,
      lastPts90k: null,
      timestampTicks: 0,
      sourcePtsTicks: 0,
      sourcePtsIntervals: 0,
      sourceGaps: [],
      lastFrameId: null,
      wasDisconnected: false,
      frameIdGaps: 0,
      lastReportedFrameIdGaps: 0,
      receiveGaps: [],
      decodeGaps: [],
      decodeLatencies: [],
      queueDelay: [],
      receiveToRender: [],
      renderGaps: [],
      pageRafGaps: [],
      poolDepthSamples: [],
      poolDepthMax: 0,
      pageRafFrames: 0,
      decodeMeta: new Map(),
    };
    native.renderer = renderer;

    const poolDepth = () =>
      renderer.texturesPool.reduce((sum, slot) => sum + (slot.used ? 1 : 0), 0);
    const recordDepth = () => {
      const depth = poolDepth();
      renderer.poolDepthSamples.push(depth);
      renderer.poolDepthMax = Math.max(renderer.poolDepthMax, depth);
      return depth;
    };
    const clearSlot = (slot) => {
      if (!slot) return;
      slot.used = false;
      slot.frameTimestamp = null;
      slot.decodedAt = null;
      slot.receivedAt = null;
    };
    const dropOldest = (reason) => {
      for (let offset = 0; offset < texturePoolLength; offset += 1) {
        const index = (renderer.playIndex + offset) % texturePoolLength;
        const slot = renderer.texturesPool[index];
        if (!slot.used) continue;
        renderer.playIndex = (index + 1) % texturePoolLength;
        clearSlot(slot);
        if (reason === 'startup') renderer.startupDrops += 1;
        else renderer.presentationDrops += 1;
        if (reason === 'vfr-late') renderer.vfrLateDrops += 1;
        recordDepth();
        return true;
      }
      return false;
    };
    const resetNativeStreamPlayout = () => {
      renderer.assembly = null;
      for (const slot of renderer.texturesPool) clearSlot(slot);
      renderer.playIndex = renderer.storeIndex;
      renderer.playoutStarted = false;
      renderer.lastPts90k = null;
      renderer.timestampTicks = 0;
      renderer.sourcePtsTicks = 0;
      renderer.sourcePtsIntervals = 0;
      renderer.lastFrameId = null;
      renderer.vfrBasePtsUs = null;
      renderer.vfrBaseLocalMs = null;
      renderer.vfrClockCorrectionMs = 0;
      renderer.vfrClockErrorEwmaMs = 0;
      renderer.vfrClockSamples = 0;
      renderer.vfrTargetSourceUs = null;
      renderer.vfrLatestSubmittedTimestampUs = null;
      renderer.vfrLastPresentedTimestampUs = null;
      renderer.vfrDropBeforeTimestampUs = null;
      renderer.lastReceiveNow = null;
      renderer.lastDecodeNow = null;
      renderer.lastRenderNow = null;
      renderer.decodeMeta.clear();
      recordDepth();
    };
    const clearNativeVideoStallWatchdog = () => {
      if (renderer.stallTimer) clearTimeout(renderer.stallTimer);
      renderer.stallTimer = 0;
    };
    const armNativeVideoStallWatchdog = ({ resetDeadline = false } = {}) => {
      clearNativeVideoStallWatchdog();
      if (
        !renderer.active ||
        attempt !== native.generation ||
        !renderer.videoStreamingActive ||
        !(renderer.stallTimeoutMs > 0)
      )
        return;
      if (resetDeadline) renderer.videoProgressAt = performance.now();
      const check = () => {
        renderer.stallTimer = 0;
        if (
          !renderer.active ||
          attempt !== native.generation ||
          !renderer.videoStreamingActive ||
          !(renderer.stallTimeoutMs > 0)
        )
          return;
        const now = performance.now();
        const renderAgeMs = Math.max(0, now - renderer.videoProgressAt);
        if (renderAgeMs < renderer.stallTimeoutMs) {
          renderer.stallTimer = setTimeout(
            check,
            Math.max(250, renderer.stallTimeoutMs - renderAgeMs),
          );
          return;
        }
        const receiveAgeMs = Number.isFinite(renderer.lastReceiveNow)
          ? Math.max(0, now - renderer.lastReceiveNow)
          : null;
        const decodeAgeMs = Number.isFinite(renderer.lastDecodeNow)
          ? Math.max(0, now - renderer.lastDecodeNow)
          : null;
        const stage =
          receiveAgeMs === null || receiveAgeMs >= renderer.stallTimeoutMs
            ? 'transport'
            : decodeAgeMs === null || decodeAgeMs >= renderer.stallTimeoutMs
              ? 'decoder'
              : 'renderer';
        failNativeLiveConnection(
          new Error(
            `Native video stalled at ${stage} ` +
              `(render=${Math.round(renderAgeMs)}ms, ` +
              `receive=${receiveAgeMs === null ? 'never' : `${Math.round(receiveAgeMs)}ms`}, ` +
              `decode=${decodeAgeMs === null ? 'never' : `${Math.round(decodeAgeMs)}ms`})`,
          ),
          attempt,
        );
      };
      renderer.stallTimer = setTimeout(check, renderer.stallTimeoutMs);
    };
    renderer.onStreamPause = () => {
      renderer.videoStreamingActive = false;
      clearNativeVideoStallWatchdog();
      resetNativeStreamPlayout();
    };
    renderer.onStreamResume = () => {
      resetNativeStreamPlayout();
      renderer.videoStreamingActive = true;
      armNativeVideoStallWatchdog({ resetDeadline: true });
    };
    const drawNext = () => {
      if (!renderer.active || attempt !== native.generation) return false;
      let slot = null;
      for (let offset = 0; offset < texturePoolLength; offset += 1) {
        const index = (renderer.playIndex + offset) % texturePoolLength;
        if (renderer.texturesPool[index].used) {
          renderer.playIndex = index;
          slot = renderer.texturesPool[index];
          break;
        }
      }
      if (!slot) return false;
      const now = performance.now();
      try {
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0 + slot.index);
        gl.bindTexture(gl.TEXTURE_2D, slot.texture);
        gl.uniform1i(textureUniform, slot.index);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      } catch (error) {
        renderer.renderErrors += 1;
        throw error;
      }
      if (Number.isFinite(slot.decodedAt))
        renderer.queueDelay.push(Math.max(0, now - slot.decodedAt));
      if (Number.isFinite(slot.receivedAt))
        renderer.receiveToRender.push(Math.max(0, now - slot.receivedAt));
      if (Number.isFinite(renderer.lastRenderNow))
        renderer.renderGaps.push(Math.max(0, now - renderer.lastRenderNow));
      renderer.lastRenderNow = now;
      renderer.videoProgressAt = now;
      renderer.framesRendered += 1;
      renderer.vfrLastPresentedTimestampUs = slot.frameTimestamp;
      if (
        Number.isFinite(slot.frameTimestamp) &&
        Number.isFinite(renderer.vfrBasePtsUs) &&
        Number.isFinite(renderer.vfrBaseLocalMs)
      ) {
        const dueAt =
          renderer.vfrBaseLocalMs +
          (slot.frameTimestamp - renderer.vfrBasePtsUs) / 1000 +
          renderer.vfrClockCorrectionMs;
        renderer.vfrPresentationLateness.push(now - dueAt);
      }
      clearSlot(slot);
      renderer.playIndex = (renderer.playIndex + 1) % texturePoolLength;
      recordDepth();
      if (native.status !== 'online') {
        native.status = 'online';
        native.statusMessage = '已连接';
        renderBrowser();
      }
      return true;
    };
    // Diagnostic mode: visibility/focus transitions are observed but do not
    // reset the renderer or mutate the Native transport.

    const storeFrame = (frame, meta) => {
      const timestamp = Number(frame.timestamp);
      if (
        Number.isFinite(renderer.vfrDropBeforeTimestampUs) &&
        Number.isFinite(timestamp) &&
        timestamp < renderer.vfrDropBeforeTimestampUs
      ) {
        renderer.vfrStaleDecodedDrops += 1;
        return;
      }
      let slot = renderer.texturesPool[renderer.storeIndex];
      if (slot.used) {
        dropOldest('overflow');
        slot = renderer.texturesPool[renderer.storeIndex];
      }
      const width = Math.max(1, Number(frame.displayWidth || frame.codedWidth || native.width));
      const height = Math.max(1, Number(frame.displayHeight || frame.codedHeight || native.height));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        native.width = width;
        native.height = height;
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      }
      gl.activeTexture(gl.TEXTURE0 + slot.index);
      gl.bindTexture(gl.TEXTURE_2D, slot.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      slot.used = true;
      slot.frameTimestamp = timestamp;
      slot.decodedAt = performance.now();
      slot.receivedAt = meta?.receivedAt ?? null;
      renderer.storeIndex = (renderer.storeIndex + 1) % texturePoolLength;
      recordDepth();
    };

    const decoderConfig = supported.config || config;
    let decoder = null;
    let decoderEpoch = 0;
    let decoderFallbackUsed = false;
    renderer.decoderRecoveries = 0;
    renderer.decoderHardwarePreference = String(
      decoderConfig.hardwareAcceleration || config.hardwareAcceleration || 'no-preference',
    );

    const handleDecodedFrame = (frame, epoch) => {
      if (epoch !== decoderEpoch) {
        try {
          frame.close();
        } catch {}
        return;
      }
      if (!renderer.active || attempt !== native.generation) {
        try {
          frame.close();
        } catch {}
        return;
      }
      const now = performance.now();
      renderer.framesDecoded += 1;
      if (Number.isFinite(renderer.lastDecodeNow))
        renderer.decodeGaps.push(Math.max(0, now - renderer.lastDecodeNow));
      renderer.lastDecodeNow = now;
      const timestamp = Number(frame.timestamp);
      const meta = renderer.decodeMeta.get(timestamp) || null;
      if (meta) {
        renderer.decodeLatencies.push(Math.max(0, now - meta.decodeSubmittedAt));
        renderer.decodeMeta.delete(timestamp);
      }
      try {
        storeFrame(frame, meta);
      } catch (error) {
        renderer.renderErrors += 1;
        failNativeLiveConnection(error, attempt);
      } finally {
        try {
          frame.close();
        } catch {}
      }
    };

    const recoverDecoderInPlace = (error, epoch) => {
      if (
        epoch !== decoderEpoch ||
        decoderFallbackUsed ||
        !renderer.active ||
        attempt !== native.generation
      )
        return false;
      decoderFallbackUsed = true;
      renderer.decoderRecoveries += 1;
      try {
        decoderEpoch += 1;
        try {
          decoder?.close();
        } catch {}
        resetNativeStreamPlayout();
        const fallbackConfig = {
          ...decoderConfig,
          hardwareAcceleration: 'prefer-software',
          optimizeForLatency: true,
        };
        const fallbackEpoch = decoderEpoch;
        decoder = new VideoDecoder({
          output: (frame) => handleDecodedFrame(frame, fallbackEpoch),
          error: (fallbackError) => {
            if (fallbackEpoch !== decoderEpoch) return;
            renderer.decodeErrors += 1;
            failNativeLiveConnection(fallbackError, attempt);
          },
        });
        decoder.configure(fallbackConfig);
        renderer.decoder = decoder;
        renderer.decoderHardwarePreference = 'prefer-software';
        renderer.videoProgressAt = performance.now();
        // Keep ICE/DTLS/SCTP and both DataChannels intact. The server turns a
        // snapshot into an encoder keyframe request, so the replacement
        // decoder can restart from a clean AV1 reference chain.
        if (!nativeSend({ t: 'snapshot' })) {
          try {
            inputDc?.send(JSON.stringify({ t: 'snapshot' }));
          } catch {}
        }
        console.warn('Native AV1 hardware decoder failed; recovered in-place with software', error);
        return true;
      } catch (fallbackError) {
        failNativeLiveConnection(fallbackError, attempt);
        return false;
      }
    };

    const initialEpoch = ++decoderEpoch;
    decoder = new VideoDecoder({
      output: (frame) => handleDecodedFrame(frame, initialEpoch),
      error: (error) => {
        if (initialEpoch !== decoderEpoch) return;
        renderer.decodeErrors += 1;
        if (recoverDecoderInPlace(error, initialEpoch)) return;
        failNativeLiveConnection(error, attempt);
      },
    });
    decoder.configure(decoderConfig);
    renderer.decoder = decoder;

    const rebaseVfrClock = (timestampUs, receivedAt, reason) => {
      for (const slot of renderer.texturesPool) clearSlot(slot);
      renderer.playIndex = renderer.storeIndex;
      renderer.vfrBasePtsUs = timestampUs;
      renderer.vfrBaseLocalMs = receivedAt + renderer.vfrTargetDelayMs;
      renderer.vfrClockCorrectionMs = 0;
      renderer.vfrClockErrorEwmaMs = 0;
      renderer.vfrClockSamples = 1;
      renderer.vfrTargetSourceUs = null;
      renderer.vfrLastPresentedTimestampUs = null;
      renderer.vfrDropBeforeTimestampUs = timestampUs;
      renderer.vfrClockRebases += 1;
      renderer.vfrLastClockRebaseReason = reason;
      recordDepth();
    };

    const updateVfrClock = (timestampUs, receivedAt, forceRebaseReason = null) => {
      if (!Number.isFinite(timestampUs) || !Number.isFinite(receivedAt)) return;
      if (forceRebaseReason) {
        rebaseVfrClock(timestampUs, receivedAt, forceRebaseReason);
        return;
      }
      if (!Number.isFinite(renderer.vfrBasePtsUs) || !Number.isFinite(renderer.vfrBaseLocalMs)) {
        renderer.vfrBasePtsUs = timestampUs;
        renderer.vfrBaseLocalMs = receivedAt + renderer.vfrTargetDelayMs;
        renderer.vfrClockCorrectionMs = 0;
        renderer.vfrClockErrorEwmaMs = 0;
        renderer.vfrClockSamples = 1;
        return;
      }

      // Keep the PTS->local clock anchor fixed. Arrival timing is used only
      // for a tiny long-term drift correction; packet jitter must never move
      // the presentation timeline frame-to-frame.
      const expectedArrivalMs =
        renderer.vfrBaseLocalMs -
        renderer.vfrTargetDelayMs +
        (timestampUs - renderer.vfrBasePtsUs) / 1000 +
        renderer.vfrClockCorrectionMs;
      const errorMs = receivedAt - expectedArrivalMs;
      if (!Number.isFinite(errorMs)) return;
      renderer.vfrClockSamples += 1;
      // The first IDR is much larger than subsequent frames. Anchoring for
      // minutes to its completion time adds its transfer/decode burst to
      // every future presentation. Calibrate the arrival lower envelope
      // during startup, without changing a single source timestamp.
      if (renderer.vfrClockSamples <= 120) {
        if (errorMs < 0) renderer.vfrClockCorrectionMs += errorMs;
        renderer.vfrClockErrorEwmaMs = 0;
        return;
      }
      // One delayed packet is network/decoder jitter, not a clock reset.
      // Clearing the pool here turned each such outlier into a visible jump.
      // Real PTS discontinuities and foreground resumes have explicit resets.
      if (errorMs > 20) return;
      renderer.vfrClockErrorEwmaMs += (errorMs - renderer.vfrClockErrorEwmaMs) * 0.002;
      if (renderer.vfrClockSamples > 120) {
        const stepMs = Math.max(-0.001, Math.min(0.001, renderer.vfrClockErrorEwmaMs * 0.0002));
        renderer.vfrClockCorrectionMs += stepMs;
      }
    };

    const raf = (now) => {
      if (!renderer.active || attempt !== native.generation) return;
      renderer.pageRafFrames += 1;
      if (Number.isFinite(renderer.lastPageRafNow))
        renderer.pageRafGaps.push(Math.max(0, now - renderer.lastPageRafNow));
      renderer.lastPageRafNow = now;

      const depth = poolDepth();
      if (
        depth > 0 &&
        Number.isFinite(renderer.vfrBasePtsUs) &&
        Number.isFinite(renderer.vfrBaseLocalMs)
      ) {
        const targetSourceUs =
          renderer.vfrBasePtsUs +
          (now - renderer.vfrBaseLocalMs - renderer.vfrClockCorrectionMs) * 1000;
        renderer.vfrTargetSourceUs = targetSourceUs;

        let dueCount = 0;
        for (let offset = 0; offset < texturePoolLength; offset += 1) {
          const slot = renderer.texturesPool[(renderer.playIndex + offset) % texturePoolLength];
          if (!slot.used) continue;
          if (!Number.isFinite(slot.frameTimestamp) || slot.frameTimestamp > targetSourceUs) break;
          dueCount += 1;
        }

        if (dueCount > 0) {
          while (dueCount > 1 && dropOldest('vfr-late')) dueCount -= 1;
          try {
            if (drawNext()) renderer.playoutStarted = true;
          } catch (error) {
            failNativeLiveConnection(error, attempt);
            return;
          }
        } else {
          // Holding the previously presented frame is the correct VFR behavior
          // when the next source timestamp has not reached its presentation
          // deadline yet. On a 240 Hz client a 120 Hz source should naturally
          // hit roughly one hold between source frames.
          renderer.vfrHolds += 1;
        }
      } else {
        renderer.vfrHolds += 1;
      }

      renderer.rafId = requestAnimationFrame(raf);
    };
    renderer.rafId = requestAnimationFrame(raf);

    const submitFrame = (flags, frameId, pts90k, payload, receivedAt, wireBytes) => {
      if (!renderer.active || attempt !== native.generation) return;
      const now = Number.isFinite(receivedAt) ? receivedAt : performance.now();
      if (Number.isFinite(renderer.lastReceiveNow))
        renderer.receiveGaps.push(Math.max(0, now - renderer.lastReceiveNow));
      renderer.lastReceiveNow = now;
      renderer.framesReceived += 1;
      renderer.bytesReceived += Number(wireBytes || payload.byteLength || 0);
      if (renderer.lastFrameId !== null) {
        const step = (frameId - renderer.lastFrameId) >>> 0;
        if (step > 1 && step < 0x80000000) {
          renderer.frameIdGaps += step - 1;
        }
      }
      renderer.lastFrameId = frameId;
      let forceClockRebaseReason = null;
      if (renderer.lastPts90k === null) renderer.timestampTicks = 0;
      else {
        let ticks = (pts90k - renderer.lastPts90k) >>> 0;
        if (ticks > 0 && ticks < 0x80000000) {
          renderer.sourcePtsTicks += ticks;
          renderer.sourcePtsIntervals += 1;
          renderer.sourceGaps.push(ticks / 90);
        }
        if (ticks === 0) ticks = 1;
        // Preserve real VFR gaps. A huge modulo delta means the source clock
        // reset/backtracked rather than a normal 32-bit 90 kHz wrap.
        if (ticks > 0x7fffffff) {
          renderer.timestampTicks += 1;
          renderer.vfrBasePtsUs = null;
          renderer.vfrBaseLocalMs = null;
          renderer.vfrClockCorrectionMs = 0;
          renderer.vfrClockErrorEwmaMs = 0;
          renderer.vfrClockSamples = 0;
          renderer.vfrTargetSourceUs = null;
          forceClockRebaseReason = 'pts-reset';
        } else {
          if (ticks >= 9_000) forceClockRebaseReason = 'vfr-gap';
          renderer.timestampTicks += ticks;
        }
      }
      renderer.lastPts90k = pts90k;
      const timestampUs = Math.round((renderer.timestampTicks * 1_000_000) / 90_000);
      renderer.vfrLatestSubmittedTimestampUs = timestampUs;
      updateVfrClock(timestampUs, now, forceClockRebaseReason);
      const decodeSubmittedAt = performance.now();
      renderer.decodeMeta.set(timestampUs, { receivedAt: now, decodeSubmittedAt, frameId });
      while (renderer.decodeMeta.size > 512)
        renderer.decodeMeta.delete(renderer.decodeMeta.keys().next().value);
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: flags & 1 ? 'key' : 'delta',
            timestamp: timestampUs,
            data: payload,
          }),
        );
      } catch (error) {
        renderer.decodeMeta.delete(timestampUs);
        renderer.decodeErrors += 1;
        failNativeLiveConnection(error, attempt);
      }
    };

    const handleTransportPacket = (data) => {
      if (!renderer.active || attempt !== native.generation || !(data instanceof ArrayBuffer))
        return;
      const packet = new Uint8Array(data);
      if (
        packet.byteLength < 24 ||
        packet[0] !== 0x4d ||
        packet[1] !== 0x57 ||
        packet[2] !== 0x44 ||
        packet[3] !== 0x31
      )
        return;
      const view = new DataView(data);
      if (view.getUint16(6) !== 24) return;
      const frameId = view.getUint32(8);
      const chunkIndex = view.getUint16(16);
      const chunkCount = view.getUint16(18);
      const totalLen = view.getUint32(20);
      if (!chunkCount || chunkIndex >= chunkCount || !totalLen) return;
      const now = performance.now();
      renderer.dcChunksReceived += 1;
      // A complete single-message frame needs no assembly object or payload copy.
      if (chunkCount === 1 && !renderer.assembly) {
        if (packet.byteLength - 24 !== totalLen) {
          renderer.dcIncompleteFrames += 1;
          return;
        }
        renderer.dcFramesAssembled += 1;
        submitFrame(packet[4], frameId, view.getUint32(12), packet.subarray(24), now, packet.byteLength);
        return;
      }
      let assembly = renderer.assembly;
      if (!assembly || assembly.frameId !== frameId) {
        if (assembly && assembly.receivedChunks !== assembly.chunkCount) {
          renderer.dcIncompleteFrames += 1;
        }
        assembly = {
          frameId,
          flags: packet[4],
          pts90k: view.getUint32(12),
          chunkCount,
          totalLen,
          chunks: new Array(chunkCount),
          receivedChunks: 0,
          receivedBytes: 0,
          wireBytes: 0,
        };
        renderer.assembly = assembly;
      }
      if (
        assembly.chunkCount !== chunkCount ||
        assembly.totalLen !== totalLen ||
        assembly.chunks[chunkIndex]
      )
        return;
      const chunk = packet.subarray(24);
      assembly.chunks[chunkIndex] = chunk;
      assembly.receivedChunks += 1;
      assembly.receivedBytes += chunk.byteLength;
      assembly.wireBytes += packet.byteLength;
      if (assembly.receivedChunks !== assembly.chunkCount) return;
      if (assembly.receivedBytes !== assembly.totalLen) {
        renderer.dcIncompleteFrames += 1;
        renderer.assembly = null;
        return;
      }
      const payload = new Uint8Array(assembly.totalLen);
      let offset = 0;
      for (const part of assembly.chunks) {
        if (!part) {
          renderer.dcIncompleteFrames += 1;
          renderer.assembly = null;
          return;
        }
        payload.set(part, offset);
        offset += part.byteLength;
      }
      renderer.dcFramesAssembled += 1;
      renderer.assembly = null;
      submitFrame(
        assembly.flags,
        assembly.frameId,
        assembly.pts90k,
        payload,
        now,
        assembly.wireBytes,
      );
    };

    let pc = null;
    let videoDc = null;
    let inputDc = null;

    pc = new RTCPeerConnection({ iceServers: [] });
    videoDc = pc.createDataChannel('video', {
      ordered: true,
      maxRetransmits: 0,
      negotiated: true,
      id: 0,
    });
    inputDc = pc.createDataChannel('input', { ordered: true, negotiated: true, id: 1 });
    videoDc.binaryType = 'arraybuffer';
    renderer.pc = pc;
    renderer.videoDc = videoDc;
    renderer.inputDc = inputDc;
    native.pc = pc;
    native.dc = inputDc;
    inputDc.addEventListener('message', handleNativeCursorMessage);

    videoDc.addEventListener('message', (event) => {
      if (renderer.videoStreamingActive) handleTransportPacket(event.data);
    });

    pc.addEventListener('connectionstatechange', () => {
      if (!renderer.active || attempt !== native.generation) return;
      if (pc.connectionState === 'disconnected') {
        renderer.wasDisconnected = true;
        if (!native.disconnectTimer) {
          native.disconnectTimer = setTimeout(() => {
            native.disconnectTimer = null;
            if (
              renderer.active &&
              attempt === native.generation &&
              native.pc === pc &&
              pc.connectionState === 'disconnected'
            ) {
              failNativeLiveConnection(
                new Error('Native DataChannel peer disconnected'),
                attempt,
              );
            }
          }, 1800);
        }
      } else if (pc.connectionState === 'connected') {
        clearTimeout(native.disconnectTimer);
        native.disconnectTimer = null;
        renderer.wasDisconnected = false;
      } else if (['failed', 'closed'].includes(pc.connectionState)) {
        clearTimeout(native.disconnectTimer);
        native.disconnectTimer = null;
        failNativeLiveConnection(
          new Error(`Native DataChannel peer ${pc.connectionState}`),
          attempt,
        );
      }
    });
    videoDc.addEventListener(
      'close',
      () => {
        if (renderer.active && attempt === native.generation)
          failNativeLiveConnection(new Error('Native video DataChannel closed'), attempt);
      },
      { once: true },
    );

    const waitOpen = (dc, label) =>
      new Promise((resolve, reject) => {
        if (dc.readyState === 'open') {
          resolve();
          return;
        }
        let timer;
        const finish = (error) => {
          clearTimeout(timer);
          dc.removeEventListener('open', opened);
          dc.removeEventListener('error', failed);
          dc.removeEventListener('close', failed);
          if (error) reject(error);
          else resolve();
        };
        const opened = () => finish();
        const failed = () => finish(new Error(`Native ${label} DataChannel failed`));
        dc.addEventListener('open', opened, { once: true });
        dc.addEventListener('error', failed, { once: true });
        dc.addEventListener('close', failed, { once: true });
        timer = setTimeout(
          () => finish(new Error(`Native ${label} DataChannel open timeout`)),
          10000,
        );
        if (dc.readyState === 'closed') failed();
      });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitRtcIce(pc);
    if (!renderer.active || attempt !== native.generation) return;
    const response = await fetch('/mcpmonitor/native/dc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sdp: pc.localDescription?.sdp || '' }),
      cache: 'no-store',
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok || !answer?.sdp)
      throw new Error(answer?.error || `Native DC HTTP ${response.status}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    // Start the channel deadline after ICE/SDP negotiation, not before it.
    await Promise.all([waitOpen(videoDc, 'video'), waitOpen(inputDc, 'input')]);

    if (!renderer.active || attempt !== native.generation) return;
    syncNativeVideoStreaming({ force: true });

    renderer.reportTimer = setInterval(() => {
      if (!renderer.active || attempt !== native.generation) return;
      const now = performance.now();
      const intervalMs = Math.max(1, now - renderer.lastReportAt);
      const received = renderer.framesReceived - renderer.lastReportedReceived;
      const decoded = renderer.framesDecoded - renderer.lastReportedDecoded;
      const rendered = renderer.framesRendered - renderer.lastReportedRendered;
      const bytes = renderer.bytesReceived - renderer.lastReportedBytes;
      const receiveGap = summarizeGaps(renderer.receiveGaps);
      const decodeGap = summarizeGaps(renderer.decodeGaps);
      const decodeLatency = summarizeGaps(renderer.decodeLatencies);
      const queueDelay = summarizeGaps(renderer.queueDelay);
      const receiveToRender = summarizeGaps(renderer.receiveToRender);
      const renderGap = summarizeGaps(renderer.renderGaps);
      const pageRafGap = summarizeGaps(renderer.pageRafGaps);
      const pool = summarizeGaps(renderer.poolDepthSamples);
      const vfrPresentationLateness = summarizeGaps(renderer.vfrPresentationLateness);
      const sourceGap = summarizeGaps(renderer.sourceGaps);
      const report = {
        backend: 'native-dc-vfr-av1',
        renderer_mode: 'native-dc-vfr',
        transport: 'rtcdatachannel',
        codec: AV1_WEBCODECS_CODEC,
        configured_max_fps: native.fps,
        source_fps_kind: 'capture-presentation-timestamps-not-app-render-loop',
        source_fps:
          renderer.sourcePtsTicks > 0
            ? Number(((renderer.sourcePtsIntervals * 90000) / renderer.sourcePtsTicks).toFixed(3))
            : null,
        source_pts_gap_avg_ms: sourceGap.avg,
        source_pts_gap_p95_ms: sourceGap.p95,
        source_pts_gap_p99_ms: sourceGap.p99,
        source_pts_gap_max_ms: sourceGap.max,
        frame_id_gaps: renderer.frameIdGaps - renderer.lastReportedFrameIdGaps,
        decoder_hardware_preference: renderer.decoderHardwarePreference,
        decoder_recoveries: renderer.decoderRecoveries,
        coded_width: native.width,
        coded_height: native.height,
        source_rate_mode: 'vfr-max',
        gl_finish: false,
        frames_per_second: Number(((received * 1000) / intervalMs).toFixed(3)),
        frames_received: received,
        frames_decoded: decoded,
        rendered_frames: rendered,
        decoded_fps: Number(((decoded * 1000) / intervalMs).toFixed(3)),
        render_submit_fps: Number(((rendered * 1000) / intervalMs).toFixed(3)),
        presentation_measurement: 'webgl-submit-not-physical-scanout',
        receive_mbps: Number(((bytes * 8) / (intervalMs * 1000)).toFixed(3)),
        transport_receive_gap_avg_ms: receiveGap.avg,
        transport_receive_gap_p95_ms: receiveGap.p95,
        transport_receive_gap_p99_ms: receiveGap.p99,
        decode_output_gap_avg_ms: decodeGap.avg,
        decode_output_gap_p95_ms: decodeGap.p95,
        decode_submit_to_output_avg_ms: decodeLatency.avg,
        decode_submit_to_output_p95_ms: decodeLatency.p95,
        decode_submit_to_output_p99_ms: decodeLatency.p99,
        decode_submit_to_output_max_ms: decodeLatency.max,
        frame_queue_delay_avg_ms: queueDelay.avg,
        frame_queue_delay_p95_ms: queueDelay.p95,
        receive_to_render_avg_ms: receiveToRender.avg,
        receive_to_render_p95_ms: receiveToRender.p95,
        render_gap_avg_ms: renderGap.avg,
        render_gap_p95_ms: renderGap.p95,
        render_gap_p99_ms: renderGap.p99,
        render_gap_max_ms: renderGap.max,
        page_raf_frames: renderer.pageRafFrames,
        page_raf_gap_avg_ms: pageRafGap.avg,
        page_raf_gap_p95_ms: pageRafGap.p95,
        page_raf_gap_max_ms: pageRafGap.max,
        gl_desynchronized: !!gl.getContextAttributes()?.desynchronized,
        pool_depth: poolDepth(),
        pool_depth_avg: pool.avg,
        pool_depth_p95: pool.p95,
        pool_depth_max: renderer.poolDepthMax,
        playout_underflows: renderer.playoutUnderflows - renderer.lastReportedUnderflows,
        presentation_drops: renderer.presentationDrops - renderer.lastReportedDrops,
        startup_drops: renderer.startupDrops - renderer.lastReportedStartupDrops,
        startup_drops_total: renderer.startupDrops,
        vfr_target_delay_ms: renderer.vfrTargetDelayMs,
        vfr_base_pts_ms: Number.isFinite(renderer.vfrBasePtsUs)
          ? renderer.vfrBasePtsUs / 1000
          : null,
        vfr_base_local_ms: renderer.vfrBaseLocalMs,
        vfr_clock_correction_ms: renderer.vfrClockCorrectionMs,
        vfr_clock_error_ewma_ms: renderer.vfrClockErrorEwmaMs,
        vfr_clock_rebases: renderer.vfrClockRebases - renderer.lastReportedVfrClockRebases,
        vfr_clock_rebases_total: renderer.vfrClockRebases,
        vfr_clock_rebase_reason: renderer.vfrLastClockRebaseReason,
        vfr_target_source_ms: Number.isFinite(renderer.vfrTargetSourceUs)
          ? renderer.vfrTargetSourceUs / 1000
          : null,
        vfr_latest_submitted_ms: Number.isFinite(renderer.vfrLatestSubmittedTimestampUs)
          ? renderer.vfrLatestSubmittedTimestampUs / 1000
          : null,
        vfr_last_presented_ms: Number.isFinite(renderer.vfrLastPresentedTimestampUs)
          ? renderer.vfrLastPresentedTimestampUs / 1000
          : null,
        vfr_holds: renderer.vfrHolds - renderer.lastReportedVfrHolds,
        vfr_holds_total: renderer.vfrHolds,
        vfr_late_drops: renderer.vfrLateDrops - renderer.lastReportedVfrLateDrops,
        vfr_late_drops_total: renderer.vfrLateDrops,
        vfr_stale_decoded_drops:
          renderer.vfrStaleDecodedDrops - renderer.lastReportedVfrStaleDecodedDrops,
        vfr_stale_decoded_drops_total: renderer.vfrStaleDecodedDrops,
        video_stall_timeout_ms: renderer.stallTimeoutMs || null,
        video_progress_age_ms: Math.max(0, performance.now() - renderer.videoProgressAt),
        vfr_presentation_lateness_avg_ms: vfrPresentationLateness.avg,
        vfr_presentation_lateness_p95_ms: vfrPresentationLateness.p95,
        vfr_presentation_lateness_max_ms: vfrPresentationLateness.max,
        foreground_resets: renderer.foregroundResets - renderer.lastReportedForegroundResets,
        foreground_resets_total: renderer.foregroundResets,
        decoder_queue_size: decoder.decodeQueueSize,
        dc_chunks_received: renderer.dcChunksReceived - renderer.lastReportedChunks,
        dc_frames_assembled: renderer.dcFramesAssembled - renderer.lastReportedAssembled,
        dc_incomplete_frames: renderer.dcIncompleteFrames - renderer.lastReportedIncomplete,
        dc_buffered_amount: Number(videoDc?.bufferedAmount || 0),
        video_dc_ordered: videoDc?.ordered ?? null,
        video_dc_max_retransmits: videoDc?.maxRetransmits ?? null,
        rtc_connection_state: pc?.connectionState ?? null,
        document_visibility: document.visibilityState,
      };
      fetch('/mcpmonitor/api/video-telemetry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
        cache: 'no-store',
        keepalive: true,
      }).catch(() => {});
      renderer.lastReportedReceived = renderer.framesReceived;
      renderer.lastReportedDecoded = renderer.framesDecoded;
      renderer.lastReportedRendered = renderer.framesRendered;
      renderer.lastReportedBytes = renderer.bytesReceived;
      renderer.lastReportedChunks = renderer.dcChunksReceived;
      renderer.lastReportedAssembled = renderer.dcFramesAssembled;
      renderer.lastReportedIncomplete = renderer.dcIncompleteFrames;
      renderer.lastReportedUnderflows = renderer.playoutUnderflows;
      renderer.lastReportedDrops = renderer.presentationDrops;
      renderer.lastReportedStartupDrops = renderer.startupDrops;
      renderer.lastReportedPllSlips = renderer.pllSlips;
      renderer.lastReportedForegroundResets = renderer.foregroundResets;
      renderer.lastReportedVfrHolds = renderer.vfrHolds;
      renderer.lastReportedVfrLateDrops = renderer.vfrLateDrops;
      renderer.lastReportedVfrStaleDecodedDrops = renderer.vfrStaleDecodedDrops;
      renderer.lastReportedVfrClockRebases = renderer.vfrClockRebases;
      renderer.lastReportAt = now;
      renderer.receiveGaps = [];
      renderer.decodeGaps = [];
      renderer.decodeLatencies = [];
      renderer.queueDelay = [];
      renderer.receiveToRender = [];
      renderer.renderGaps = [];
      renderer.pageRafFrames = 0;
      renderer.pageRafGaps = [];
      renderer.poolDepthSamples = [];
      renderer.poolDepthMax = poolDepth();
      renderer.vfrPresentationLateness = [];
      renderer.sourcePtsTicks = 0;
      renderer.sourcePtsIntervals = 0;
      renderer.sourceGaps = [];
      renderer.lastReportedFrameIdGaps = renderer.frameIdGaps;
    }, 1000);
  }


  function connectNativeLive() {
    const native = state.nativeLive;
    if (!state.videoMonitor.open || !state.authenticated || nativeConnectionActive()) return;
    const attempt = native.generation;
    native.status = 'connecting';
    native.statusMessage = '正在连接';
    renderBrowser();
    native.connectPromise = connectNativeLiveVfr(attempt)
      .catch((error) => {
        failNativeLiveConnection(error, attempt);
      })
      .finally(() => {
        if (attempt === native.generation) native.connectPromise = null;
      });
  }

  function browserSend(message) {
    const ws = state.browser.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (state.videoMonitor.open && state.authenticated) scheduleBrowserReconnect();
      return false;
    }
    // Input is a stream, not RPC. Avoid allocating IDs for high-rate pointer
    // and wheel events now that the browser side intentionally emits no
    // per-input result messages.
    const payload =
      message.type === 'input' ? message : { id: `ui-${state.browser.nextId++}`, ...message };
    ws.send(JSON.stringify(payload));
    return true;
  }

  function releaseBrowserKeys({ forceModifiers = false } = {}) {
    const keys = new Set(state.browser.pressedKeys);
    state.browser.pressedKeys.clear();
    if (forceModifiers) {
      for (const key of ['Shift', 'Control', 'Alt', 'Meta']) keys.add(key);
    }
    for (const key of keys) {
      browserSend({ type: 'input', event: { kind: 'key', native: true, action: 'up', key } });
    }
  }

  function cancelQueuedBrowserInput() {
    if (state.browser.moveRaf) cancelAnimationFrame(state.browser.moveRaf);
    if (state.browser.wheelTimer) clearTimeout(state.browser.wheelTimer);
    state.browser.moveRaf = 0;
    state.browser.wheelTimer = 0;
    state.browser.movePending = null;
    state.browser.wheelPending = null;
  }

  function browserHandleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === 'state' && message.patch && typeof message.patch === 'object') {
      state.browser.data = { ...(state.browser.data || {}), ...message.patch };
      renderBrowser();
      if (!videoConnectionActive()) {
        scheduleVideoReconnect();
      }
      return;
    }
    if (message.type === 'error') {
      state.browser.statusMessage = message.message || message.error || '浏览器操作失败';
      renderBrowser();
      return;
    }
  }

  function disconnectBrowser({ keepStatus = false } = {}) {
    clearTimeout(state.browser.reconnectTimer);
    state.browser.reconnectTimer = null;
    const ws = state.browser.ws;
    releaseBrowserKeys();
    if (state.browser.pointerDown && state.browser.pointerDragging && state.browser.pointerLast) {
      sendBrowserMouse({
        action: 'up',
        button: state.browser.pointerButton,
        ...state.browser.pointerLast,
      });
    }
    cancelQueuedBrowserInput();
    state.browser.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close(1000, 'panel closed');
      } catch {}
    }
    state.browser.pointerDown = false;
    state.browser.pointerId = null;
    state.browser.pointerType = null;
    state.browser.pointerStart = null;
    state.browser.pointerLast = null;
    state.browser.pointerStartClient = null;
    state.browser.pointerDragging = false;
    if (!keepStatus) {
      state.browser.status = 'idle';
      state.browser.statusMessage = '未连接';
    }
    renderBrowser();
  }

  function scheduleBrowserReconnect() {
    if (!state.videoMonitor.open || !state.authenticated || state.browser.reconnectTimer) return;
    state.browser.reconnectTimer = setTimeout(() => {
      state.browser.reconnectTimer = null;
      connectBrowser();
    }, 1200);
  }

  function connectBrowser() {
    if (!state.videoMonitor.open || !state.authenticated) return;
    if (
      state.browser.ws &&
      [WebSocket.CONNECTING, WebSocket.OPEN].includes(state.browser.ws.readyState)
    )
      return;
    state.browser.status = 'connecting';
    state.browser.statusMessage = '正在连接';
    renderBrowser();
    const ws = new WebSocket(browserWsUrl());
    state.browser.ws = ws;
    ws.addEventListener('open', () => {
      if (state.browser.ws !== ws) return;
      state.browser.status = 'online';
      state.browser.statusMessage = '已连接';
      renderBrowser();
      if (!videoConnectionActive()) scheduleVideoReconnect({ immediate: true });
      // A control socket can disappear while the host still has a modifier
      // held. Its keyup can never cross that dead socket, so clear the common
      // modifiers before accepting fresh input on a new connection.
      releaseBrowserKeys({ forceModifiers: true });
      browserSend({ type: 'state' });
    });
    ws.addEventListener('message', (event) => {
      if (state.browser.ws !== ws || typeof event.data !== 'string') return;
      browserHandleMessage(event.data);
    });
    ws.addEventListener('close', () => {
      if (state.browser.ws !== ws) return;
      state.browser.ws = null;
      state.browser.status = 'offline';
      state.browser.statusMessage = '连接中断';
      renderBrowser();
      scheduleBrowserReconnect();
    });
    ws.addEventListener('error', () => {
      if (state.browser.ws === ws) {
        state.browser.status = 'offline';
        state.browser.statusMessage = '无法连接浏览器';
        renderBrowser();
      }
    });
  }

  function setVideoMonitorOpen(open, { persist = true } = {}) {
    state.videoMonitor.open = !!open;
    if (state.videoMonitor.open && state.videoMonitor.panelWidth > 0)
      applyBrowserPanelWidth(state.videoMonitor.panelWidth);
    renderBrowser();
    if (state.videoMonitor.open) {
      connectBrowser();
      scheduleVideoReconnect();
      scheduleNativeReconnect({ immediate: true });
      scheduleAudioReconnect({ immediate: true });
    } else {
      disconnectAudio();
      disconnectVideo();
      disconnectNativeLive();
      disconnectBrowser();
    }
    if (persist) persistPageState();
  }

  function setRemoteSurfaceCollapsed(surface, collapsed, { persist = true } = {}) {
    collapsed = !!collapsed;
    if (surface === 'browser') {
      if (collapsed && state.nativeLive.surfaceCollapsed) state.nativeLive.surfaceCollapsed = false;
      state.browser.surfaceCollapsed = collapsed;
      if (collapsed) releaseBrowserKeys();
    } else if (surface === 'native') {
      if (collapsed && state.browser.surfaceCollapsed) state.browser.surfaceCollapsed = false;
      state.nativeLive.surfaceCollapsed = collapsed;
      if (collapsed) {
        releaseNativeInput();
        if (document.pointerLockElement === $('native-surface')) document.exitPointerLock?.();
      }
    } else {
      return;
    }
    renderBrowser();
    if (collapsed) {
      requestAnimationFrame(() => {
        if (surface === 'browser') {
          try {
            $('native-surface').focus({ preventScroll: true });
          } catch {
            $('native-surface').focus();
          }
        } else {
          focusBrowserStage();
        }
      });
    }
    if (persist) persistPageState();
    syncVideoStreaming();
    requestAnimationFrame(renderAgentCursor);
  }

  function restoreRemoteSplit({ persist = true } = {}) {
    state.browser.surfaceCollapsed = false;
    state.nativeLive.surfaceCollapsed = false;
    renderBrowser();
    if (persist) persistPageState();
    syncVideoStreaming();
    requestAnimationFrame(renderAgentCursor);
  }

  function suspendBrowserConnections() {
    // Keep both RTC associations alive while the page is hidden. Only gate the
    // high-rate video subscriptions so background tabs do not receive/decode
    // 120 fps. Audio/control/ICE/DTLS/SCTP remain established.
    if (!Number.isFinite(state.browser.suspendedAt)) state.browser.suspendedAt = Date.now();
    syncVideoStreaming();
  }

  const PAGE_SLEEP_RECOVERY_GAP_MS = 5000;

  function resumeBrowserConnections({ immediate = false, forceFresh = false } = {}) {
    const now = Date.now();
    state.browser.suspendedAt = null;
    state.browser.lifecycleHeartbeatAt = now;
    // Visibility/sleep alone is not a reason to rebuild WebRTC. Only explicit
    // network recovery asks for a fresh transport now.
    state.browser.resumeForceFresh = state.browser.resumeForceFresh || forceFresh;
    if (!state.videoMonitor.open || !state.authenticated) return;
    // Native keeps ICE/DTLS/SCTP alive while hidden. Resume its video demand
    // synchronously on foreground so capture/keyframe work starts in this same
    // visibility/focus event instead of waiting for the browser recovery timer.
    // Resume both visible video producers in this foreground event. The later
    // recovery pass only has to rebuild transports that actually died while
    // the page was backgrounded.
    syncVideoStreaming();
    if (!nativeConnectionActive()) scheduleNativeReconnect({ immediate: true });
    clearTimeout(state.browser.resumeTimer);
    state.browser.resumeTimer = setTimeout(
      () => {
        state.browser.resumeTimer = null;
        const refreshTransports = state.browser.resumeForceFresh;
        state.browser.resumeForceFresh = false;
        if (refreshTransports) {
          // A sleeping Chromium tab can resume with apparently live RTC objects
          // even though frames no longer arrive. Rebuild all transports after a
          // real suspension/network restore so stale state cannot block reconnect.
          disconnectAudio({ keepStatus: true });
          disconnectVideo({ keepStatus: true });
          disconnectBrowser({ keepStatus: true });
          disconnectNativeLive({ keepStatus: true });
        }
        if (!state.browser.ws || state.browser.ws.readyState > WebSocket.OPEN) connectBrowser();
        if (!videoConnectionActive()) scheduleVideoReconnect({ immediate: true });
        if (state.browser.audio.enabled && !audioConnectionActive())
          scheduleAudioReconnect({ immediate: true });
        if (!nativeConnectionActive()) scheduleNativeReconnect({ immediate: true });
        syncVideoStreaming();
      },
      immediate ? 0 : 100,
    );
  }

  function normalizedBrowserPoint(event) {
    const stage = $('browser-surface');
    const rect = stage.getBoundingClientRect();
    const viewport = currentVideoViewport();
    const width = Number(viewport?.width || 0);
    const height = Number(viewport?.height || 0);
    // Native input and video decoding are independent transports. Keep the
    // desktop interactive while WebRTC video is reconnecting as long as
    // the browser-control WebSocket itself is healthy.
    const controlReady =
      state.browser.status === 'online' && state.browser.ws?.readyState === WebSocket.OPEN;
    if (!rect.width || !rect.height || !width || !height || !controlReady) return null;
    const scale = Math.min(rect.width / width, rect.height / height);
    const renderedWidth = width * scale;
    const renderedHeight = height * scale;
    const left = rect.left + (rect.width - renderedWidth) / 2;
    const top = rect.top + (rect.height - renderedHeight) / 2;
    const x = event.clientX - left;
    const y = event.clientY - top;
    if (x < 0 || y < 0 || x > renderedWidth || y > renderedHeight) return null;
    return {
      x: Math.min(1, Math.max(0, x / renderedWidth)),
      y: Math.min(1, Math.max(0, y / renderedHeight)),
    };
  }

  function pointerButtonName(button) {
    return { 0: 'left', 1: 'middle', 2: 'right' }[button] || 'left';
  }

  function sendBrowserMouse(event) {
    browserSend({
      type: 'input',
      event: { kind: 'mouse', native: true, ...event },
    });
  }

  function queueBrowserMove(point) {
    state.browser.movePending = point;
    if (state.browser.moveRaf) return;
    state.browser.moveRaf = requestAnimationFrame(() => {
      state.browser.moveRaf = 0;
      const latest = state.browser.movePending;
      state.browser.movePending = null;
      if (latest) sendBrowserMouse({ action: 'move', ...latest });
    });
  }

  function queueBrowserWheel(point, dx, dy) {
    const accumulate = (current, incoming) => {
      const a = Number(current) || 0;
      const b = Number(incoming) || 0;
      // A direction reversal is user intent, not inertia. Drop any unsent
      // opposite-direction debt immediately so the remote side reverses too.
      const next = a && b && Math.sign(a) !== Math.sign(b) ? b : a + b;
      return Math.max(-BROWSER_WHEEL_BACKLOG_LIMIT, Math.min(BROWSER_WHEEL_BACKLOG_LIMIT, next));
    };
    const pending = state.browser.wheelPending;
    if (pending) {
      pending.x = point.x;
      pending.y = point.y;
      pending.dx = accumulate(pending.dx, dx);
      pending.dy = accumulate(pending.dy, dy);
    } else {
      state.browser.wheelPending = {
        x: point.x,
        y: point.y,
        dx: accumulate(0, dx),
        dy: accumulate(0, dy),
      };
    }
    scheduleBrowserWheelFlush();
  }

  function scheduleBrowserWheelFlush() {
    if (state.browser.wheelTimer) return;
    state.browser.wheelTimer = setTimeout(flushBrowserWheel, BROWSER_WHEEL_FLUSH_MS);
  }

  function flushBrowserWheel() {
    state.browser.wheelTimer = 0;
    const pending = state.browser.wheelPending;
    if (!pending) return;
    const clampPacket = (value) =>
      Math.max(
        -BROWSER_WHEEL_PACKET_LIMIT,
        Math.min(BROWSER_WHEEL_PACKET_LIMIT, Number(value) || 0),
      );
    const dx = clampPacket(pending.dx);
    const dy = clampPacket(pending.dy);
    pending.dx -= dx;
    pending.dy -= dy;
    // Avoid keeping floating-point dust alive forever on precision touchpads.
    if (Math.abs(pending.dx) < 0.01) pending.dx = 0;
    if (Math.abs(pending.dy) < 0.01) pending.dy = 0;
    if (dx || dy) sendBrowserMouse({ action: 'wheel', x: pending.x, y: pending.y, dx, dy });
    if (pending.dx || pending.dy) scheduleBrowserWheelFlush();
    else state.browser.wheelPending = null;
  }

  function desiredListWindow(cache = listCache()) {
    const list = $('call-list');
    const viewportRows = Math.max(1, Math.ceil(Math.max(1, list.clientHeight) / LIST_ROW_HEIGHT));
    const pinned = pinnedUserInputCount(cache);
    const firstVisible = pinned + Math.max(0, Math.floor(list.scrollTop / LIST_ROW_HEIGHT));
    const start = Math.max(pinned, firstVisible - viewportRows);
    const theoreticalEnd = firstVisible + viewportRows * 2;
    const end = cache.count == null ? theoreticalEnd : Math.min(cache.count, theoreticalEnd);
    return { start, end: Math.max(start, end), viewportRows, pinned };
  }

  function desiredFetchWindow(cache = listCache()) {
    const render = desiredListWindow(cache);
    const prefetch = render.viewportRows * LIST_PREFETCH_VIEWPORTS;
    const start = Math.max(0, render.start - prefetch);
    const theoreticalEnd = render.end + prefetch;
    const end = cache.count == null ? theoreticalEnd : Math.min(cache.count, theoreticalEnd);
    return { start, end: Math.max(start, end) };
  }

  function ensureListScaffold() {
    const list = $('call-list');
    let space = list.querySelector('.list-virtual-space');
    let rows = list.querySelector('.list-rows');
    if (!space || !rows) {
      space = document.createElement('div');
      space.className = 'list-virtual-space';
      rows = document.createElement('div');
      rows.className = 'list-rows';
      space.appendChild(rows);
      list.replaceChildren(space);
    }
    return { list, space, rows };
  }

  function makeListNode(index, call) {
    if (!call) {
      const placeholder = document.createElement('div');
      placeholder.className = 'list-row-placeholder';
      placeholder.dataset.index = String(index);
      placeholder.style.top = `${index * LIST_ROW_HEIGHT}px`;
      placeholder.setAttribute('aria-hidden', 'true');
      return placeholder;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.index = String(index);
    button.style.top = `${index * LIST_ROW_HEIGHT}px`;
    updateListNode(button, call);
    button.addEventListener('click', () => selectCall(button.dataset.call));
    return button;
  }

  function updateListNode(node, call) {
    const selected = call.id === state.selected;
    // Include today's local date so the compact timestamp automatically gains
    // a date after midnight even when the underlying call data did not change.
    const signature = [
      call.id,
      call.tool,
      call.status,
      call.title,
      call.started_at,
      call.ended_at,
      call.duration_ms,
      selected ? 1 : 0,
      localDateKey(Date.now()),
    ].join('|');
    if (node.classList.contains('call-row') && node.dataset.signature === signature) return node;
    const icon =
      call.status === 'running'
        ? ''
        : call.tool === 'exec_command'
          ? terminalIcon()
          : escape(toolIcon(call.tool));
    const activeUserInput = call.kind === 'userInput' && call.status === 'running';
    node.className = `call-row ${selected ? 'selected' : ''} ${activeUserInput ? 'user-input-active' : ''}`;
    node.dataset.call = call.id;
    node.dataset.signature = signature;
    node.innerHTML = `<span class="call-icon tool-${escape(call.tool)} ${statusClass(call.status)}">${icon}</span>
      <span class="call-line" title="${escape(call.title || '')}">${callInlineHtml(call)}</span>
      ${callTimingHtml(call)}`;
    return node;
  }

  function reconcileListRows(rows, cache, start, end) {
    const existing = new Map();
    for (const node of Array.from(rows.children)) {
      const index = Number(node.dataset.index);
      if (!Number.isFinite(index) || index < start || index >= end) node.remove();
      else existing.set(index, node);
    }

    for (let index = start; index < end; index += 1) {
      const call = cache.items.get(index);
      let node = existing.get(index);
      const wantsRow = !!call;
      if (!node || wantsRow !== node.classList.contains('call-row')) {
        const replacement = makeListNode(index, call);
        if (node) node.replaceWith(replacement);
        else {
          const next = Array.from(rows.children).find(
            (candidate) => Number(candidate.dataset.index) > index,
          );
          rows.insertBefore(replacement, next || null);
        }
        node = replacement;
      } else if (call) {
        updateListNode(node, call);
      }
      node.dataset.index = String(index);
      node.style.top = `${index * LIST_ROW_HEIGHT}px`;
    }
  }

  function renderCallList(scrollLatest = false) {
    const cache = listCache();
    const list = $('call-list');
    renderSessionStats();
    renderPinnedCallList(cache);
    if (scrollLatest && state.follow) list.scrollTop = 0;

    if (cache.count === 0) {
      if (!list.querySelector('.list-empty')) {
        const empty = document.createElement('div');
        empty.className = 'list-empty';
        empty.textContent = '暂无调用';
        list.replaceChildren(empty);
      }
      state.listRender.start = 0;
      state.listRender.end = 0;
      return;
    }

    const { space, rows } = ensureListScaffold();
    const range = desiredListWindow(cache);
    state.listRender.start = range.start;
    state.listRender.end = range.end;
    const virtualCount = cache.count == null ? range.end : cache.count;
    space.style.height = `${Math.max(0, virtualCount - range.pinned) * LIST_ROW_HEIGHT}px`;
    rows.style.transform = range.pinned
      ? `translateY(${-range.pinned * LIST_ROW_HEIGHT}px)`
      : '';
    reconcileListRows(rows, cache, range.start, range.end);
  }

  function setSessionStats(value) {
    const next = value && typeof value === 'object' ? value : {};
    state.stats = {
      files_changed: Number(next.files_changed || 0),
      additions: Number(next.additions || 0),
      deletions: Number(next.deletions || 0),
      command_calls: Number(next.command_calls || 0),
      cua_calls: Number(next.cua_calls ?? next.browser_calls ?? 0),
      tool_calls: Number(next.tool_calls || 0),
    };
    renderSessionStats();
  }

  function renderSessionStats() {
    const stats = state.stats || {};
    $('stat-files').textContent = String(Number(stats.files_changed || 0));
    $('stat-additions').textContent = `+${Number(stats.additions || 0)}`;
    $('stat-deletions').textContent = `-${Number(stats.deletions || 0)}`;
    $('stat-commands').textContent = String(Number(stats.command_calls || 0));
    $('stat-browser').textContent = String(Number(stats.cua_calls || 0));
    $('stat-tools').textContent = String(Number(stats.tool_calls || 0));
  }

  function listFilterParams(filter = state.filter) {
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('tool', filter);
    if (state.timeRange === 'custom') {
      if (state.customSince != null) params.set('since', String(state.customSince));
      if (state.customUntil != null) params.set('until', String(state.customUntil));
    } else {
      const cutoff = rangeCutoff(state.timeRange);
      if (cutoff != null) params.set('since', String(cutoff));
    }
    const query = ($('search').value || '').trim();
    if (query) params.set('q', query);
    return params;
  }

  function missingListRanges(cache, start, end) {
    const ranges = [];
    let rangeStart = null;
    for (let index = start; index < end; index += 1) {
      const missing = !cache.items.has(index) && !cache.pending.has(index);
      if (missing && rangeStart == null) rangeStart = index;
      if (!missing && rangeStart != null) {
        ranges.push([rangeStart, index]);
        rangeStart = null;
      }
    }
    if (rangeStart != null) ranges.push([rangeStart, end]);
    return ranges;
  }

  async function fetchListRange(cache, filter, start, end) {
    if (!state.authenticated || end <= start) return;
    const generation = cache.generation;
    const revision = cache.revision;
    const pendingToken = Symbol('list-range');
    for (let index = start; index < end; index += 1) cache.pending.set(index, pendingToken);
    const params = listFilterParams(filter);
    params.set('offset', String(start));
    params.set('limit', String(end - start));
    try {
      const response = await fetch(`/mcpmonitor/api/calls?${params.toString()}`, {
        cache: 'no-store',
      });
      if (response.status === 401) {
        clearAuth();
        return;
      }
      if (!response.ok) throw new Error('list');
      const data = await response.json();
      if (
        generation !== state.listGeneration ||
        cache.generation !== generation ||
        cache.revision !== revision
      )
        return;
      cache.count = Number(data.count || 0);
      const calls = Array.isArray(data.calls) ? data.calls : [];
      for (let offset = 0; offset < calls.length; offset += 1) {
        const index = start + offset;
        const previous = cache.items.get(index);
        if (previous?.id && previous.id !== calls[offset].id) cache.byId.delete(previous.id);
        cache.items.set(index, calls[offset]);
        if (calls[offset]?.id) cache.byId.set(calls[offset].id, index);
      }
      if (cache.count != null) {
        for (const [index, call] of Array.from(cache.items.entries())) {
          if (index >= cache.count) {
            cache.items.delete(index);
            if (call?.id) cache.byId.delete(call.id);
          }
        }
      }
      if (listCache() === cache) {
        renderCallList(false);
        renderSelectedCallMeta();
      }
    } catch {
      if (generation === state.listGeneration) setBanner('调用列表加载失败');
    } finally {
      for (let index = start; index < end; index += 1) {
        if (cache.pending.get(index) === pendingToken) cache.pending.delete(index);
      }
      if (
        generation === state.listGeneration &&
        cache.revision !== revision &&
        listCache() === cache
      ) {
        scheduleListDataEnsure(0);
      }
    }
  }

  function ensureListData() {
    if (!state.authenticated) return;
    const filter = state.filter;
    const cache = listCache(filter);
    const prefixEnd = Math.min(
      cache.count == null ? LIST_PINNED_DISCOVERY_LIMIT : cache.count,
      LIST_PINNED_DISCOVERY_LIMIT,
    );
    for (const [start, end] of missingListRanges(cache, 0, prefixEnd)) {
      fetchListRange(cache, filter, start, end);
    }
    const range = desiredFetchWindow(cache);
    for (const [start, end] of missingListRanges(cache, range.start, range.end)) {
      fetchListRange(cache, filter, start, end);
    }
  }

  function scheduleListDataEnsure(delay = 18) {
    clearTimeout(state.listRender.ensureTimer);
    state.listRender.ensureTimer = setTimeout(ensureListData, delay);
  }

  function renderListSync() {
    const sync = state.listSync;
    const shell = $('list-sync');
    if (!shell) return;
    const progress = $('list-sync-progress');
    const label = $('list-sync-label');
    const live = sync.mode === 'live';
    shell.classList.toggle('hidden', live);
    if (live) {
      shell.classList.remove('indeterminate');
      shell.style.removeProperty('--list-sync-progress');
      progress.removeAttribute('aria-valuenow');
      label.textContent = '';
      return;
    }
    const determinate = sync.mode === 'catchup' && sync.total > 0;
    shell.classList.toggle('indeterminate', !determinate);
    if (determinate) {
      const percent = Math.max(0, Math.min(100, (sync.applied / sync.total) * 100));
      shell.style.setProperty('--list-sync-progress', `${percent}%`);
      progress.setAttribute('aria-valuenow', String(Math.round(percent)));
      label.textContent = `正在追最新 ${Math.min(sync.applied, sync.total)}/${sync.total}`;
    } else {
      shell.style.removeProperty('--list-sync-progress');
      progress.removeAttribute('aria-valuenow');
      label.textContent = sync.mode === 'reconnecting' ? '正在重新连接' : '正在重新同步调用记录';
    }
  }

  function setListSyncMode(mode, values = {}) {
    state.listSync.mode = mode;
    for (const key of ['from', 'to', 'applied', 'total']) {
      if (values[key] != null && Number.isFinite(Number(values[key]))) {
        state.listSync[key] = Number(values[key]);
      }
    }
    renderListSync();
  }

  function trackStreamRevision(event) {
    const revision = Number(event?.lastEventId || 0);
    if (!Number.isFinite(revision) || revision <= 0) return;
    state.listSync.revision = Math.max(state.listSync.revision, revision);
    if (state.listSync.mode !== 'catchup') return;
    state.listSync.applied = Math.max(
      state.listSync.applied,
      Math.min(state.listSync.total, revision - state.listSync.from),
    );
    renderListSync();
  }

  function captureListAnchor() {
    if (state.follow) return null;
    const list = $('call-list');
    const cache = listCache();
    const pinned = pinnedUserInputCount(cache);
    const visualRow = Math.max(0, Math.floor(list.scrollTop / LIST_ROW_HEIGHT));
    const approximateIndex = pinned + visualRow;
    const viewportRows = Math.max(1, Math.ceil(Math.max(1, list.clientHeight) / LIST_ROW_HEIGHT));
    let index = approximateIndex;
    let call = cache.items.get(index);
    if (!call) {
      for (let distance = 1; distance <= viewportRows * 2; distance += 1) {
        const below = approximateIndex + distance;
        const above = approximateIndex - distance;
        if (cache.items.has(below)) {
          index = below;
          call = cache.items.get(below);
          break;
        }
        if (above >= pinned && cache.items.has(above)) {
          index = above;
          call = cache.items.get(above);
          break;
        }
      }
    }
    return {
      id: call?.id || null,
      index,
      viewportOffset: (index - pinned) * LIST_ROW_HEIGHT - list.scrollTop,
      fallbackScrollTop: list.scrollTop,
    };
  }

  async function reconcileCallListOnce(reason) {
    if (!state.authenticated) return;
    const filter = state.filter;
    const baseParams = listFilterParams(filter);
    const signature = `${filter}|${baseParams.toString()}`;
    const list = $('call-list');
    const cache = listCache(filter);
    const anchor = captureListAnchor();
    const viewportRows = Math.max(1, Math.ceil(Math.max(1, list.clientHeight) / LIST_ROW_HEIGHT));
    const before = Math.max(viewportRows * 2, LIST_PINNED_DISCOVERY_LIMIT);
    const limit = Math.min(5000, Math.max(64, viewportRows * 6, LIST_PINNED_DISCOVERY_LIMIT * 2));
    const params = new URLSearchParams(baseParams);
    params.set('limit', String(limit));
    if (anchor?.id) {
      params.set('anchor', anchor.id);
      params.set('before', String(before));
    } else if (state.follow) {
      params.set('offset', '0');
    } else {
      const pinned = pinnedUserInputCount(cache);
      const approximateIndex = pinned + Math.max(0, Math.floor(list.scrollTop / LIST_ROW_HEIGHT));
      params.set('offset', String(Math.max(0, approximateIndex - before)));
    }
    setListSyncMode('reconciling');
    // A fresh database snapshot subsumes every list change published before
    // this request. Only changes that race this request make the pass dirty.
    state.listSync.pendingChanges.length = 0;
    try {
      const response = await fetch(`/mcpmonitor/api/calls?${params.toString()}`, {
        cache: 'no-store',
      });
      if (response.status === 401) {
        clearAuth();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!state.authenticated) return;
      const currentParams = listFilterParams(state.filter);
      if (`${state.filter}|${currentParams.toString()}` !== signature) {
        state.listSync.pendingChanges.length = 0;
        state.listSync.reconcileRequested = true;
        return;
      }
      if (state.listSync.pendingChanges.length) {
        // We cannot know whether a concurrently published insert landed just
        // before or just after the SQLite snapshot. Re-applying it could shift
        // absolute virtual-list indexes twice, so retry from a clean snapshot.
        state.listSync.pendingChanges.length = 0;
        state.listSync.reconcileRequested = true;
        return;
      }
      if (
        !state.follow &&
        anchor &&
        Math.abs($('call-list').scrollTop - anchor.fallbackScrollTop) > 1
      ) {
        // The user moved while the snapshot was in flight. Never snap them
        // back to the old anchor; immediately take a fresh anchor instead.
        state.listSync.reconcileRequested = true;
        return;
      }

      resetListCaches();
      const nextCache = listCache(filter);
      nextCache.count = Number(data.count || 0);
      const offset = Math.max(0, Number(data.offset || 0));
      const calls = Array.isArray(data.calls) ? data.calls : [];
      for (let itemOffset = 0; itemOffset < calls.length; itemOffset += 1) {
        const index = offset + itemOffset;
        nextCache.items.set(index, calls[itemOffset]);
      }
      rebuildCacheIds(nextCache);

      // First render establishes the new virtual height. The second render runs
      // after restoring the logical call anchor, so a paused viewport never
      // jumps merely because newer rows appeared above it.
      renderCallList(false);
      if (state.follow) {
        list.scrollTop = 0;
      } else if (anchor?.id && Number.isFinite(Number(data.anchor_index))) {
        const anchorIndex = Number(data.anchor_index);
        const pinned = Math.max(0, Number(data.pinned_count || 0));
        list.scrollTop = Math.max(
          0,
          (anchorIndex - pinned) * LIST_ROW_HEIGHT - anchor.viewportOffset,
        );
      } else if (anchor) {
        list.scrollTop = Math.max(
          0,
          Math.min(anchor.fallbackScrollTop, Math.max(0, list.scrollHeight - list.clientHeight)),
        );
      }
      renderCallList(false);
      renderSelectedCallMeta();
      if (state.follow) list.scrollTop = 0;
      renderCallList(false);
      scheduleListDataEnsure(0);
    } catch (error) {
      setBanner(`调用列表同步失败：${String(error?.message || error || reason)}`);
    }
  }

  function reconcileCallList(reason = 'reconcile') {
    if (!state.authenticated) return Promise.resolve();
    if (state.listSync.reconcilePromise) {
      state.listSync.reconcileRequested = true;
      return state.listSync.reconcilePromise;
    }
    state.listSync.reconcilePromise = (async () => {
      let nextReason = reason;
      do {
        state.listSync.reconcileRequested = false;
        await reconcileCallListOnce(nextReason);
        nextReason = 'coalesced';
      } while (state.authenticated && state.listSync.reconcileRequested);
    })().finally(() => {
      state.listSync.reconcilePromise = null;
      if (state.listSync.mode === 'reconciling') setListSyncMode('live');
    });
    return state.listSync.reconcilePromise;
  }

  function listSummaryMatches(left, right) {
    if (!left || !right) return false;
    return (
      left.id === right.id &&
      left.tool === right.tool &&
      left.status === right.status &&
      Number(left.started_at || 0) === Number(right.started_at || 0) &&
      Number(left.ended_at || 0) === Number(right.ended_at || 0) &&
      Number(left.duration_ms ?? -1) === Number(right.duration_ms ?? -1)
    );
  }

  async function verifyListHead(reason = 'foreground') {
    if (!state.authenticated) return;
    const filter = state.filter;
    const params = listFilterParams(filter);
    const signature = `${filter}|${params.toString()}`;
    params.set('offset', '0');
    params.set('limit', String(LIST_PINNED_DISCOVERY_LIMIT));
    try {
      const response = await fetch(`/mcpmonitor/api/calls?${params.toString()}`, {
        cache: 'no-store',
      });
      if (response.status === 401) {
        clearAuth();
        return;
      }
      if (!response.ok) return;
      const data = await response.json();
      if (!state.authenticated) return;
      const currentParams = listFilterParams(state.filter);
      if (`${state.filter}|${currentParams.toString()}` !== signature) return;
      const cache = listCache(filter);
      const calls = Array.isArray(data.calls) ? data.calls : [];
      const count = Number(data.count || 0);
      let mismatch = cache.count == null || cache.count !== count;
      if (!mismatch) {
        for (let index = 0; index < calls.length; index += 1) {
          if (!listSummaryMatches(cache.items.get(index), calls[index])) {
            mismatch = true;
            break;
          }
        }
      }
      if (mismatch) await reconcileCallList(reason);
    } catch {}
  }

  function scheduleListHeadVerify(reason = 'foreground', delay = 75) {
    clearTimeout(state.listSync.verifyTimer);
    state.listSync.verifyTimer = setTimeout(() => {
      state.listSync.verifyTimer = null;
      if (
        state.source?.readyState !== EventSource.OPEN ||
        ['catchup', 'reconnecting'].includes(state.listSync.mode)
      ) {
        state.listSync.foregroundVerifyPending = true;
        return;
      }
      void verifyListHead(reason);
    }, delay);
  }


  function callMatchesToolFilter(filter, tool) {
    if (filter === 'all') return true;
    if (filter === 'browser') return /^(browser_|cua_repl\.)/.test(String(tool || ''));
    return filter === tool;
  }

  function activeUserInput(call) {
    return call?.kind === 'userInput' && call?.status === 'running';
  }

  function pinnedUserInputCount(cache) {
    let count = 0;
    while (activeUserInput(cache.items.get(count))) count += 1;
    return count;
  }

  function renderPinnedCallList(cache = listCache()) {
    const container = $('pinned-call-list');
    if (!container) return;
    const count = pinnedUserInputCount(cache);
    if (!count) {
      container.replaceChildren();
      container.classList.add('hidden');
      return;
    }
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < count; index += 1) {
      const call = cache.items.get(index);
      if (!call) continue;
      const button = document.createElement('button');
      button.type = 'button';
      updateListNode(button, call);
      button.classList.add('pinned-call-row');
      button.style.top = '';
      button.addEventListener('click', () => selectCall(call.id));
      fragment.appendChild(button);
    }
    container.replaceChildren(fragment);
    container.classList.remove('hidden');
  }

  function applyListChange(change) {
    const call = change?.call;
    if (!call?.id) return;
    const inserting = change.operation === 'insert';
    if (inserting) syncFollowFromViewport();
    let currentChanged = false;
    let requiresReorder = false;
    for (const cache of state.listCaches.values()) {
      const knownIndex = cache.byId.get(call.id);
      if (knownIndex == null) continue;
      const previous = cache.items.get(knownIndex);
      if (activeUserInput(previous) && !activeUserInput(call)) {
        requiresReorder = true;
        break;
      }
    }
    if (requiresReorder) {
      void reconcileCallList('call-reorder');
      return;
    }
    for (const [filter, cache] of state.listCaches) {
      if (!callMatchesToolFilter(filter, call.tool)) continue;
      const knownIndex = cache.byId.get(call.id);
      if (knownIndex != null) {
        cache.items.set(knownIndex, call);
        currentChanged ||= filter === state.filter;
        continue;
      }
      if (!inserting) continue;
      cache.revision += 1;
      cache.pending.clear();
      const insertIndex = activeUserInput(call) ? 0 : pinnedUserInputCount(cache);
      const shifted = new Map();
      for (const [index, item] of cache.items)
        shifted.set(index >= insertIndex ? index + 1 : index, item);
      cache.items = shifted;
      if (cache.count != null) cache.count += 1;
      cache.items.set(insertIndex, call);
      rebuildCacheIds(cache);
      currentChanged ||= filter === state.filter;
    }
    if (!state.listCaches.has(state.filter)) return;
    if (inserting && currentChanged && !state.follow && !activeUserInput(call))
      $('call-list').scrollTop += LIST_ROW_HEIGHT;
    if (state.follow) $('call-list').scrollTop = 0;
    if (currentChanged) renderCallList(false);
    scheduleListDataEnsure(0);
  }

  function copyButton(text, label = '复制') {
    return `<button class="copy-button" data-copy='${escape(text || '')}'>${label}</button>`;
  }

  function patchHtml(input) {
    return String(input || '')
      .split('\n')
      .map((line) => {
        const cls =
          line.startsWith('+') && !line.startsWith('+++')
            ? 'add'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'remove'
              : line.startsWith('***') || line.startsWith('@@')
                ? 'meta'
                : '';
        return `<span class="patch-line ${cls}">${escape(line) || ' '}</span>`;
      })
      .join('');
  }

  function argumentDetail(call) {
    const args = call.arguments || {};
    if (call.tool === 'exec_command') {
      const rest = { ...args };
      delete rest.cmd;
      return `<section class="detail-section"><div class="section-head"><h2>命令</h2>${copyButton(args.cmd || '')}</div><pre class="code-block">${escape(args.cmd || '')}</pre></section>
        ${Object.keys(rest).length ? `<section class="detail-section"><div class="section-head"><h2>参数</h2>${copyButton(JSON.stringify(rest, null, 2))}</div><pre class="code-block compact">${escape(JSON.stringify(rest, null, 2))}</pre></section>` : ''}`;
    }
    if (call.tool === 'apply_patch') {
      return `<section class="detail-section"><div class="section-head"><h2>补丁</h2>${copyButton(args.input || '')}</div><div class="patch">${patchHtml(args.input || '')}</div></section>`;
    }
    if (call.tool === 'view_image') {
      const image =
        typeof call.image === 'string' &&
        /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(call.image)
          ? call.image
          : null;
      return `<section class="detail-section"><div class="section-head"><h2>图像</h2>${copyButton(args.path || '')}</div><div class="path-line">${escape(args.path || '')}</div>${image ? `<img class="detail-image" src="${escape(image)}" alt="${escape(args.path || '图像')}">` : ''}</section>`;
    }
    if (call.tool === 'write_stdin') {
      const text = args.chars || '';
      return `<section class="detail-section"><div class="section-head"><h2>${text ? '输入' : '轮询'}</h2>${text ? copyButton(text) : ''}</div>${text ? `<pre class="code-block">${escape(text)}</pre>` : ''}</section>`;
    }
    if (String(call.tool || '').startsWith('browser_')) {
      const text = JSON.stringify(args, null, 2);
      return `<section class="detail-section"><div class="section-head"><h2>浏览器操作</h2>${copyButton(text)}</div><pre class="code-block compact">${escape(text)}</pre></section>`;
    }
    return `<section class="detail-section"><div class="section-head"><h2>参数</h2>${copyButton(JSON.stringify(args, null, 2))}</div><pre class="code-block compact">${escape(JSON.stringify(args, null, 2))}</pre></section>`;
  }

  function outputDetail(call) {
    if (!call.output) return '';
    return `<section class="detail-section"><div class="section-head"><h2>输出${call.truncated ? ' · 已截断' : ''}</h2>${copyButton(call.output)}</div><pre class="code-block output ${call.status === 'failed' ? 'error-output' : ''}">${escape(call.output)}</pre></section>`;
  }

  function userInputQuestionHtml(question, index) {
    const id = escape(question.id || `q${index + 1}`);
    const options = Array.isArray(question.options) ? question.options : null;
    const header = escape(question.header || `问题 ${index + 1}`);
    const prompt = escape(question.question || '');
    if (!options) {
      return `<section class="user-input-question" data-user-question="${id}">
        <div class="user-input-header">${header}</div>
        <div class="user-input-prompt">${prompt}</div>
        <textarea class="user-input-text" data-user-free placeholder="输入回答"></textarea>
      </section>`;
    }
    const rows = options
      .map(
        (option, optionIndex) => `<label class="user-input-option">
          <input type="radio" name="user-${id}" value="${escape(option.label || '')}" ${optionIndex === 0 ? 'checked' : ''}>
          <span><strong>${escape(option.label || '')}</strong>${option.description ? `<small>${escape(option.description)}</small>` : ''}</span>
        </label>`,
      )
      .join('');
    const other = question.isOther
      ? `<label class="user-input-option"><input type="radio" name="user-${id}" value="__other__"><span><strong>None of the above</strong><small>输入其他回答</small></span></label>`
      : '';
    return `<section class="user-input-question" data-user-question="${id}">
      <div class="user-input-header">${header}</div>
      <div class="user-input-prompt">${prompt}</div>
      <div class="user-input-options">${rows}${other}</div>
      <textarea class="user-input-text" data-user-note placeholder="补充说明（可选）"></textarea>
    </section>`;
  }

  function userInputFormHtml(call) {
    const request = call.user_input;
    if (!request || request.terminal) return '';
    const stateLabel = request.status === 'opened' ? '你已打开这个问题' : '尚未查看';
    const expiry = request.expires_at
      ? `<span>自动结束 ${escape(formatDateTime(request.expires_at))}</span>`
      : '<span>打开后停止自动选择推荐项</span>';
    return `<section class="detail-section user-input-panel" data-user-input-call="${escape(call.id)}">
      <div class="user-input-state"><strong>${escape(stateLabel)}</strong>${expiry}</div>
      <div class="user-input-questions">${(request.questions || []).map(userInputQuestionHtml).join('')}</div>
      <div class="user-input-actions"><button class="text-button user-input-submit" type="button" data-user-input-submit>提交回答</button></div>
    </section>`;
  }

  function captureUserInputDraft() {
    const panel = $('detail').querySelector('[data-user-input-call]');
    if (!panel || panel.dataset.userInputSubmitted === '1') return;
    const callId = panel.dataset.userInputCall;
    if (!callId) return;
    const questions = {};
    for (const section of panel.querySelectorAll('[data-user-question]')) {
      const id = section.dataset.userQuestion;
      if (!id) continue;
      const selected = section.querySelector('input[type="radio"]:checked');
      questions[id] = {
        selected: selected?.value ?? null,
        free: section.querySelector('[data-user-free]')?.value ?? null,
        note: section.querySelector('[data-user-note]')?.value ?? null,
      };
    }
    let focus = null;
    const active = document.activeElement;
    if (active && panel.contains(active)) {
      const section = active.closest?.('[data-user-question]');
      const field = active.matches?.('[data-user-free]')
        ? 'free'
        : active.matches?.('[data-user-note]')
          ? 'note'
          : null;
      if (section?.dataset.userQuestion && field) {
        focus = {
          id: section.dataset.userQuestion,
          field,
          start: Number.isFinite(active.selectionStart) ? active.selectionStart : null,
          end: Number.isFinite(active.selectionEnd) ? active.selectionEnd : null,
        };
      }
    }
    state.userInputDrafts.set(callId, { questions, focus });
  }

  function restoreUserInputDraft(call) {
    const draft = state.userInputDrafts.get(String(call?.id || ''));
    const panel = $('detail').querySelector('[data-user-input-call]');
    if (!draft || !panel) return;
    for (const section of panel.querySelectorAll('[data-user-question]')) {
      const saved = draft.questions?.[section.dataset.userQuestion];
      if (!saved) continue;
      const free = section.querySelector('[data-user-free]');
      const note = section.querySelector('[data-user-note]');
      if (free && saved.free != null) free.value = saved.free;
      if (note && saved.note != null) note.value = saved.note;
      if (saved.selected != null) {
        for (const radio of section.querySelectorAll('input[type="radio"]')) {
          radio.checked = radio.value === saved.selected;
        }
      }
    }
    const focus = draft.focus;
    if (!focus) return;
    const section = Array.from(panel.querySelectorAll('[data-user-question]')).find(
      (node) => node.dataset.userQuestion === focus.id,
    );
    const target = section?.querySelector(focus.field === 'free' ? '[data-user-free]' : '[data-user-note]');
    if (!target) return;
    try {
      target.focus({ preventScroll: true });
      if (focus.start != null && focus.end != null) target.setSelectionRange(focus.start, focus.end);
    } catch {}
  }

  function collectUserInputResponse(call) {
    const request = call.user_input;
    const answers = {};
    for (const question of request?.questions || []) {
      const section = $('detail').querySelector(
        `[data-user-question="${CSS.escape(String(question.id || ''))}"]`,
      );
      const options = Array.isArray(question.options) ? question.options : null;
      if (!options) {
        const value = section?.querySelector('[data-user-free]')?.value?.trim() || '';
        if (!value) throw new Error(`请回答：${question.question || ''}`);
        answers[question.id] = { answers: [value] };
        continue;
      }
      const selected = section?.querySelector(
        `input[name="user-${CSS.escape(String(question.id || ''))}"]:checked`,
      )?.value;
      const note = section?.querySelector('[data-user-note]')?.value?.trim() || '';
      if (!selected) throw new Error(`请选择：${question.question || ''}`);
      if (selected === '__other__') {
        if (!note) throw new Error(`请输入：${question.question || ''}`);
        answers[question.id] = { answers: [note] };
      } else {
        answers[question.id] = {
          answers: note ? [selected, `user_note: ${note}`] : [selected],
        };
      }
    }
    return { answers };
  }

  async function submitUserInput(call) {
    const button = $('detail').querySelector('[data-user-input-submit]');
    if (button) button.disabled = true;
    try {
      const response = await fetch(
        `/mcpmonitor/api/user-input/${encodeURIComponent(call.id)}/answer`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(collectUserInputResponse(call)),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      const panel = $('detail').querySelector('[data-user-input-call]');
      if (panel) panel.dataset.userInputSubmitted = '1';
      state.userInputDrafts.delete(String(call.id));
      toast('回答已提交');
      await loadDetail(call.id, true);
    } catch (error) {
      if (button) button.disabled = false;
      toast(error?.message || '提交失败');
    }
  }

  function renderSelectedCallMeta() {
    if (!state.selected) {
      $('selected-index').textContent = '—';
      $('selected-status').className = 'status-badge hidden';
      return;
    }
    const cached = cachedCall(state.selected);
    if (cached?.call) {
      const count = cached.cache.count;
      const ordinal = count == null ? cached.index + 1 : Math.max(1, count - cached.index);
      $('selected-index').textContent = `调用 ${String(ordinal).padStart(2, '0')}`;
      $('selected-status').textContent = statusText(cached.call.status);
      $('selected-status').className = `status-badge ${statusClass(cached.call.status)}`;
    }
  }

  function renderDetail() {
    captureUserInputDraft();
    renderSelectedCallMeta();
    if (!state.selected) {
      $('detail').innerHTML = '<div class="empty-state"><span>⌘</span></div>';
      refreshCustomScrollbars($('detail'));
      return;
    }
    if (state.detailLoading && !state.detail) {
      $('detail').innerHTML =
        '<div class="empty-state"><span>…</span><strong>正在加载调用详情</strong></div>';
      refreshCustomScrollbars($('detail'));
      return;
    }
    const call = state.detail;
    if (!call || call.id !== state.selected) {
      $('detail').innerHTML =
        '<div class="empty-state"><span>⌘</span><strong>调用详情暂不可用</strong></div>';
      refreshCustomScrollbars($('detail'));
      return;
    }
    const process = call.process_id || call.arguments?.session_id;
    const timing = callTiming(call);
    const meta = [
      [timing.label, formatDateTime(timing.stamp)],
      ['耗时', timing.duration],
      process ? ['Process', process] : null,
      call.exit_code != null ? ['Exit', call.exit_code] : null,
    ].filter(Boolean);
    $('detail').innerHTML = `<article class="call-detail">
      <header class="detail-head">
        <div class="detail-icon ${statusClass(call.status)}">${call.status === 'running' ? '' : toolIcon(call.tool)}</div>
        <div class="detail-title"><span>${escape(call.tool)}</span><h1>${escape(call.title || call.tool)}</h1></div>
      </header>
      <div class="meta-grid">${meta.map(([key, value]) => `<div><span>${escape(key)}</span><strong>${escape(value)}</strong></div>`).join('')}</div>
      ${call.kind === 'userInput' && call.status === 'running' ? userInputFormHtml(call) : argumentDetail(call)}
      ${outputDetail(call)}
    </article>`;
    $('detail')
      .querySelectorAll('[data-copy]')
      .forEach((button) =>
        button.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(button.dataset.copy);
            toast('已复制');
          } catch {
            toast('复制失败');
          }
        }),
      );
    $('detail')
      .querySelector('[data-user-input-submit]')
      ?.addEventListener('click', () => submitUserInput(call));
    if (call.kind === 'userInput' && call.status === 'running') restoreUserInputDraft(call);
    else if (call.kind === 'userInput') state.userInputDrafts.delete(String(call.id));
    refreshCustomScrollbars($('detail'));
  }

  async function loadDetail(id, quiet = false, markOpened = false) {
    if (!id || !state.authenticated) return;
    if (!quiet) {
      state.detail = null;
      state.detailLoading = true;
      renderDetail();
    }
    try {
      const response = await fetch(`/mcpmonitor/api/calls/${encodeURIComponent(id)}`, {
        cache: 'no-store',
      });
      if (response.status === 401) {
        clearAuth();
        return;
      }
      if (!response.ok) throw new Error('detail');
      const detail = await response.json();
      if (detail.kind === 'userInput' && detail.status === 'running') {
        const path = `/mcpmonitor/api/user-input/${encodeURIComponent(id)}`;
        if (markOpened) {
          await fetch(`${path}/opened`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }).catch(() => null);
        }
        const requestResponse = await fetch(path, { cache: 'no-store' });
        if (requestResponse.ok) detail.user_input = await requestResponse.json();
      }
      if (state.selected === id) {
        state.detail = detail;
        state.detailLoading = false;
        renderDetail();
      }
    } catch {
      if (state.selected === id && !quiet) {
        state.detailLoading = false;
        renderDetail();
      }
    }
  }

  function selectCall(id) {
    state.selected = id;
    persistPageState();
    renderCallList(false);
    loadDetail(id, false, true);
    if (logicalViewportWidth() <= 720) $('sidebar').classList.remove('visible');
  }

  function updateFollowButton() {
    $('follow').textContent = state.follow ? '跟随最新' : '已暂停';
    $('follow').setAttribute('aria-pressed', String(state.follow));
  }

  function setFollow(next, { explicitPause = false, persist = true } = {}) {
    const follow = !!next;
    const changed = state.follow !== follow || state.followPauseExplicit !== !!explicitPause;
    state.follow = follow;
    state.followPauseExplicit = follow ? false : !!explicitPause;
    if (!changed) return;
    updateFollowButton();
    if (persist) persistPageState();
  }

  function syncFollowFromViewport({ persist = true } = {}) {
    const list = $('call-list');
    const atTop = list.scrollTop <= FOLLOW_TOP_EPSILON;
    if (atTop) {
      if (!state.follow && !state.followPauseExplicit) setFollow(true, { persist });
      return;
    }
    if (state.follow || state.followPauseExplicit) {
      setFollow(false, { explicitPause: false, persist });
    }
  }

  function eventUrl() {
    const params = new URLSearchParams();
    if (state.timeRange === 'custom') {
      if (state.customSince != null) params.set('since', String(state.customSince));
      if (state.customUntil != null) params.set('until', String(state.customUntil));
    } else if (state.timeRange !== 'all') {
      params.set('range', state.timeRange);
      params.set('utc_offset_minutes', String(-new Date().getTimezoneOffset()));
    }
    const query = ($('search').value || '').trim();
    if (query) params.set('q', query);
    return `/mcpmonitor/api/events?${params.toString()}`;
  }

  function callInWindow(call, since, until) {
    if (activeUserInput(call)) return true;
    const startedAt = Number(call?.started_at || 0);
    if (since != null && startedAt < since) return false;
    if (until != null && startedAt >= until) return false;
    return true;
  }

  function applyWindowShift(snapshot) {
    const since =
      snapshot?.since == null || !Number.isFinite(Number(snapshot.since))
        ? null
        : Number(snapshot.since);
    const until =
      snapshot?.until == null || !Number.isFinite(Number(snapshot.until))
        ? null
        : Number(snapshot.until);
    const counts = snapshot?.counts && typeof snapshot.counts === 'object' ? snapshot.counts : {};
    for (const [filter, cache] of state.listCaches) {
      cache.revision += 1;
      cache.pending.clear();
      const nextCount = Number(counts[filter]);
      if (Number.isFinite(nextCount) && nextCount >= 0) cache.count = nextCount;
      for (const [index, call] of Array.from(cache.items.entries())) {
        if (
          (cache.count != null && index >= cache.count) ||
          !callInWindow(call, since, until)
        ) {
          cache.items.delete(index);
        }
      }
      rebuildCacheIds(cache);
    }
    if (snapshot?.stats) setSessionStats(snapshot.stats);
    renderCallList(false);
    renderSelectedCallMeta();
    scheduleListDataEnsure(0);
  }

  function startEvents({ preserveConnection = false } = {}) {
    if (!state.authenticated) return;
    syncFollowFromViewport();
    if (state.source) state.source.close();
    if (!preserveConnection || state.connection !== 'online') {
      state.connection = 'connecting';
      state.connectionMessage = '正在连接';
      renderConnection();
    }
    const source = new EventSource(eventUrl());
    state.source = source;
    renderCallList(false);
    scheduleListDataEnsure(0);

    source.addEventListener('connection', (event) => {
      if (state.source !== source) return;
      trackStreamRevision(event);
      try {
        const data = JSON.parse(event.data);
        state.connection = data.connection || 'connecting';
        state.connectionMessage = data.message || '';
        renderConnection();
      } catch {}
    });

    source.addEventListener('list_change', (event) => {
      if (state.source !== source) return;
      trackStreamRevision(event);
      try {
        const change = JSON.parse(event.data);
        const call = change?.call;
        if (state.selected === call?.id) loadDetail(call.id, true);
        if (state.listSync.mode === 'reconciling') state.listSync.pendingChanges.push(change);
        else applyListChange(change);
      } catch {
        setBanner('调用列表增量数据版本不兼容');
      }
    });

    source.addEventListener('stats', (event) => {
      if (state.source !== source) return;
      trackStreamRevision(event);
      try {
        setSessionStats(JSON.parse(event.data));
      } catch {
        setBanner('会话统计数据版本不兼容');
      }
    });

    source.addEventListener('window_shift', (event) => {
      if (state.source !== source) return;
      try {
        applyWindowShift(JSON.parse(event.data));
      } catch {
        setBanner('滑动时间窗口增量数据版本不兼容');
      }
    });

    source.addEventListener('gap', (event) => {
      if (state.source !== source) return;
      trackStreamRevision(event);
      try {
        setBanner(JSON.parse(event.data).message || '观察流存在缺口');
      } catch {
        setBanner('观察流存在缺口');
      }
      void reconcileCallList('stream-gap');
    });

    source.addEventListener('source_restart', (event) => {
      if (state.source !== source) return;
      trackStreamRevision(event);
      toast('codex-mcp 已重启');
    });

    source.addEventListener('list_reset', (event) => {
      if (state.source !== source) return;
      trackStreamRevision(event);
      let removed = [];
      try {
        const data = JSON.parse(event.data);
        removed = Array.isArray(data.removed) ? data.removed : [];
      } catch {}
      if (state.selected && removed.includes(state.selected)) {
        state.selected = null;
        state.detail = null;
        state.detailLoading = false;
        renderDetail();
      }
      void reconcileCallList('list-reset');
    });

    source.addEventListener('user_input_notify', (event) => {
      if (state.source !== source) return;
      trackStreamRevision(event);
      try {
        const request = JSON.parse(event.data);
        if (!request?.id) return;
        if (request.terminal) {
          postServiceWorkerMessage({ type: 'resolve-user-input', request });
          if (state.selected === request.id) loadDetail(request.id, true);
        } else if (
          state.push.enabled &&
          !state.push.subscribed &&
          'Notification' in window &&
          Notification.permission === 'granted'
        ) {
          postServiceWorkerMessage({
            type: 'show-user-input',
            request: userInputNotificationRequest(request),
          });
        }
      } catch {}
    });

    source.addEventListener('catchup_begin', (event) => {
      if (state.source !== source || state.listSync.mode === 'reconciling') return;
      try {
        const data = JSON.parse(event.data);
        setListSyncMode('catchup', {
          from: Number(data.from || 0),
          to: Number(data.to || 0),
          total: Number(data.total || 0),
          applied: 0,
        });
      } catch {
        setListSyncMode('catchup', { from: 0, to: 0, total: 0, applied: 0 });
      }
    });

    source.addEventListener('catchup_end', () => {
      if (state.source !== source) return;
      if (state.listSync.mode === 'catchup') setListSyncMode('live');
    });

    source.addEventListener('reconcile_required', (event) => {
      if (state.source !== source) return;
      trackStreamRevision(event);
      void reconcileCallList('replay-miss');
    });

    source.addEventListener('stream_cursor', (event) => {
      if (state.source !== source) return;
      trackStreamRevision(event);
    });

    source.addEventListener('bootstrap', (event) => {
      if (state.source !== source) return;
      trackStreamRevision(event);
      if (state.listSync.mode === 'reconnecting') setListSyncMode('live');
      if (state.listSync.foregroundVerifyPending) {
        state.listSync.foregroundVerifyPending = false;
        if (state.listSync.mode !== 'reconciling') scheduleListHeadVerify('foreground');
      }
    });

    source.addEventListener('auth_expired', () => clearAuth());
    source.onerror = async () => {
      if (state.source !== source) return;
      if (state.listSync.mode !== 'reconciling') setListSyncMode('reconnecting');
      state.connection = 'connecting';
      state.connectionMessage = '正在重连';
      renderConnection();
      try {
        const response = await fetch('/mcpmonitor/api/me', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        if (!data.authenticated) {
          clearAuth();
        }
      } catch {}
    };
  }

  function restartEvents({ resetCaches = true } = {}) {
    if (resetCaches) {
      resetListCaches();
      $('call-list').scrollTop = 0;
      renderCallList(false);
      state.listSync.pendingChanges.length = 0;
      setListSyncMode('live');
    }
    startEvents({ preserveConnection: true });
    if (!resetCaches) void reconcileCallList('manual-reconnect');
  }

  function setTimePopover(open) {
    $('time-popover').classList.toggle('hidden', !open);
    $('time-filter').setAttribute('aria-expanded', String(open));
  }

  function updateTimeButton() {
    const label =
      state.timeRange === 'custom' && state.customStart && state.customEnd
        ? `${state.customStart} 至 ${state.customEnd}`
        : rangeLabels[state.timeRange] || state.timeRange;
    $('time-filter').title = `时间区间：${label}`;
    $('time-filter').classList.toggle('active', state.timeRange === 'custom');
  }

  function clearAuth({ redirect = true } = {}) {
    state.authenticated = false;
    state.push.subscribed = false;
    disconnectAudio();
    disconnectVideo();
    disconnectNativeLive();
    disconnectBrowser();
    if (state.source) {
      state.source.close();
      state.source = null;
    }
    clearTimeout(state.listSync.verifyTimer);
    state.listSync.verifyTimer = null;
    state.listSync.foregroundVerifyPending = false;
    state.listSync.pendingChanges.length = 0;
    state.listSync.reconcileRequested = false;
    setListSyncMode('live');
    resetListCaches();
    setSessionStats(null);
    state.selected = null;
    state.detail = null;
    state.detailLoading = false;
    renderCallList(false);
    renderDetail();
    updateNotificationButton();
    if (redirect) beginOidc();
  }

  let oidcRedirecting = false;
  function beginOidc() {
    if (oidcRedirecting) return;
    oidcRedirecting = true;
    const id = new URLSearchParams(window.location.search).get('request');
    const target = new URL('/mcpmonitor/auth/start', window.location.origin);
    if (id && /^[A-Za-z0-9_-]{1,128}$/.test(id)) target.searchParams.set('request', id);
    window.location.replace(target.toString());
  }

  async function checkAuth() {
    try {
      const response = await fetch('/mcpmonitor/api/me', { cache: 'no-store' });
      if (!response.ok) throw new Error('auth');
      const data = await response.json();
      state.authenticated = !!data.authenticated;
      if (state.authenticated) {
        startEvents();
        openPendingUserInputLink();
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          syncPushSubscription();
        } else {
          updateNotificationButton();
        }
        if (state.videoMonitor.open) setVideoMonitorOpen(true, { persist: false });
      } else {
        clearAuth();
      }
    } catch {
      // Do not treat a network or server outage as an expired login.
      clearAuth({ redirect: false });
    }
  }

  $('logout').addEventListener('click', async () => {
    try {
      await disablePushSubscription({ preservePreference: true, silent: true });
      await fetch('/mcpmonitor/auth/logout', { method: 'POST' });
    } finally {
      clearAuth({ redirect: false });
      const endpoint = new URL('/oidc/logout', window.location.origin);
      endpoint.searchParams.set('post_logout_redirect_uri', `${window.location.origin}/mcpmonitor/`);
      window.location.replace(endpoint.toString());
    }
  });
  $('reconnect').addEventListener('click', () => {
    restartEvents({ resetCaches: false });
    toast('正在重新连接');
  });
  $('theme').addEventListener('click', () => {
    state.themeExplicit = true;
    state.dark = !state.dark;
    setTheme();
  });
  $('notifications').addEventListener('click', async () => {
    if (state.push.enabled) {
      await disablePushSubscription();
    } else {
      await syncPushSubscription({ requestPermission: true, create: true });
    }
  });
  $('zoom').addEventListener('change', (event) => {
    const next = Number(event.target.value);
    if (!ZOOM_LEVELS.includes(next)) return;
    state.zoom = next;
    setZoom();
  });
  $('follow').addEventListener('click', () => {
    if (state.follow) {
      setFollow(false, { explicitPause: true });
    } else {
      setFollow(true);
      requestAnimationFrame(() => {
        $('call-list').scrollTop = 0;
        renderCallList(false);
        scheduleListDataEnsure(0);
      });
    }
  });
  $('call-list').addEventListener(
    'scroll',
    () => {
      syncFollowFromViewport();
      renderCallList(false);
      scheduleListDataEnsure();
    },
    { passive: true },
  );
  new ResizeObserver(() => {
    renderCallList(false);
    scheduleListDataEnsure();
  }).observe($('call-list'));

  let searchTimer = null;
  $('search').addEventListener('input', (event) => {
    state.search = String(event.target.value || '').slice(0, 512);
    persistPageState();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(restartEvents, 250);
  });
  document.querySelectorAll('.filter').forEach((button) =>
    button.addEventListener('click', () => {
      if (button.dataset.filter === state.filter) return;
      document.querySelectorAll('.filter').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      state.filter = button.dataset.filter;
      persistPageState();
      $('call-list').scrollTop = 0;
      renderCallList(false);
      scheduleListDataEnsure(0);
    }),
  );
  $('time-filter').addEventListener('click', (event) => {
    event.stopPropagation();
    setTimePopover($('time-popover').classList.contains('hidden'));
  });
  $('time-popover').addEventListener('click', (event) => event.stopPropagation());
  document.querySelectorAll('.range-filter').forEach((button) =>
    button.addEventListener('click', () => {
      document.querySelectorAll('.range-filter').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      state.timeRange = button.dataset.range;
      state.customSince = null;
      state.customUntil = null;
      state.customStart = '';
      state.customEnd = '';
      $('custom-date-start').value = '';
      $('custom-date-end').value = '';
      $('custom-range-error').textContent = '';
      updateTimeButton();
      persistPageState();
      setTimePopover(false);
      restartEvents();
    }),
  );
  $('custom-range-apply').addEventListener('click', () => {
    const startValue = $('custom-date-start').value;
    const endValue = $('custom-date-end').value;
    const bounds = customRangeBounds(startValue, endValue);
    if (!bounds) {
      $('custom-range-error').textContent =
        startValue && endValue ? '日期范围无效' : '请选择起止日期';
      return;
    }
    $('custom-range-error').textContent = '';
    document.querySelectorAll('.range-filter').forEach((item) => item.classList.remove('active'));
    state.timeRange = 'custom';
    state.customSince = bounds.since;
    state.customUntil = bounds.until;
    state.customStart = startValue;
    state.customEnd = endValue;
    updateTimeButton();
    persistPageState();
    setTimePopover(false);
    restartEvents();
  });
  ['custom-date-start', 'custom-date-end'].forEach((id) =>
    $(id).addEventListener('change', () => {
      $('custom-range-error').textContent = '';
      state.customStart = $('custom-date-start').value;
      state.customEnd = $('custom-date-end').value;
      persistPageState();
    }),
  );
  document.addEventListener('click', () => setTimePopover(false));
  $('open-sidebar').addEventListener('click', () => $('sidebar').classList.add('visible'));
  $('close-sidebar').addEventListener('click', () => $('sidebar').classList.remove('visible'));
  $('sidebar-reveal').addEventListener('click', () => setSidebarCollapsed(false));
  $('main-toggle').addEventListener('click', () => {
    if (state.mainCollapsed) setMainCollapsed(false);
  });

  const sidebarResizer = $('sidebar-resizer');
  const finishSidebarResize = (event) => {
    if (!state.sidebarResizing) return;
    if (
      event?.pointerId != null &&
      state.sidebarResizerPointerId != null &&
      event.pointerId !== state.sidebarResizerPointerId
    )
      return;
    state.sidebarResizing = false;
    state.sidebarResizerPointerId = null;
    $('sidebar').classList.remove('resizing');
    document.documentElement.classList.remove('sidebar-panel-resizing');
    try {
      sidebarResizer.releasePointerCapture(event?.pointerId);
    } catch {}
    applySidebarWidth(state.sidebarWidth, { persist: true });
  };
  sidebarResizer.addEventListener('pointerdown', (event) => {
    if (state.sidebarCollapsed || logicalViewportWidth() <= 720) return;
    event.preventDefault();
    state.sidebarResizing = true;
    state.sidebarResizerPointerId = event.pointerId;
    state.sidebarResizerStartX = Number(event.clientX || 0);
    state.sidebarResizerStartWidth = logicalElementWidth($('sidebar'));
    $('sidebar').classList.add('resizing');
    document.documentElement.classList.add('sidebar-panel-resizing');
    try {
      sidebarResizer.setPointerCapture(event.pointerId);
    } catch {}
  });
  sidebarResizer.addEventListener('pointermove', (event) => {
    if (!state.sidebarResizing || event.pointerId !== state.sidebarResizerPointerId) return;
    event.preventDefault();
    const delta = (Number(event.clientX || 0) - state.sidebarResizerStartX) / uiScaleFactor();
    const requestedWidth = state.sidebarResizerStartWidth + delta;
    if (requestedWidth <= 24) {
      state.sidebarResizing = false;
      state.sidebarResizerPointerId = null;
      $('sidebar').classList.remove('resizing');
      document.documentElement.classList.remove('sidebar-panel-resizing');
      try {
        sidebarResizer.releasePointerCapture(event.pointerId);
      } catch {}
      setSidebarCollapsed(true);
      return;
    }
    if (!state.mainCollapsed && state.videoMonitor.open && logicalViewportWidth() > 900) {
      const browserWidth = logicalElementWidth($('browser-panel'));
      if (mainPaneWouldCollapse(requestedWidth, browserWidth)) {
        setMainCollapsed(true, { persist: false });
        applySidebarWidth(requestedWidth);
        return;
      }
    }
    const limits = sidebarPanelLimits();
    if (requestedWidth < limits.min) {
      const previewWidth = Math.max(24, Math.round(requestedWidth));
      $('sidebar').style.setProperty('--sidebar-width', `${previewWidth}px`);
      sidebarResizer.setAttribute('aria-valuenow', String(previewWidth));
      requestAnimationFrame(renderAgentCursor);
      return;
    }
    applySidebarWidth(requestedWidth);
  });
  sidebarResizer.addEventListener('pointerup', finishSidebarResize);
  sidebarResizer.addEventListener('pointercancel', finishSidebarResize);
  sidebarResizer.addEventListener('keydown', (event) => {
    if (state.sidebarCollapsed || logicalViewportWidth() <= 720) return;
    const limits = sidebarPanelLimits();
    const current = logicalElementWidth($('sidebar'));
    const step = event.shiftKey ? 64 : 24;
    let next = null;
    if (event.key === 'ArrowLeft') next = current - step;
    else if (event.key === 'ArrowRight') next = current + step;
    else if (event.key === 'Home') next = limits.min;
    else if (event.key === 'End') next = limits.max;
    if (next == null) return;
    event.preventDefault();
    applySidebarWidth(next, { persist: true });
  });

  $('browser-toggle').addEventListener('click', () => {
    unlockBrowserAudio();
    const restoreMainCollapsed = !!state.videoMonitor.reopenMainCollapsed;
    state.videoMonitor.reopenMainCollapsed = false;
    setVideoMonitorOpen(true, { persist: false });
    if (restoreMainCollapsed) setMainCollapsed(true, { persist: false });
    persistPageState();
  });
  $('browser-hide').addEventListener('click', () => {
    state.videoMonitor.reopenMainCollapsed = !!state.mainCollapsed;
    if (state.mainCollapsed) setMainCollapsed(false, { persist: false });
    setVideoMonitorOpen(false);
  });
  $('browser-audio-toggle').addEventListener('click', () => {
    const audio = state.browser.audio;
    if (audio.enabled && audio.context?.state !== 'running') {
      unlockBrowserAudio();
      if (!audioConnectionActive()) scheduleAudioReconnect({ immediate: true });
      return;
    }
    audio.enabled = !audio.enabled;
    persistPageState();
    if (audio.enabled) {
      unlockBrowserAudio();
      if (state.videoMonitor.open) scheduleAudioReconnect({ immediate: true });
    } else {
      disconnectAudio();
    }
    renderBrowser();
  });
  function disconnectBrowserFrontendForRefresh() {
    disconnectAudio({ keepStatus: true });
    disconnectVideo({ keepStatus: true });
    disconnectBrowser({ keepStatus: true });
    state.browser.status = 'connecting';
    state.browser.statusMessage = '正在刷新';
    state.browser.video.status = 'connecting';
    state.browser.video.statusMessage = '正在刷新';
    if (state.browser.audio.enabled) {
      state.browser.audio.status = 'connecting';
      state.browser.audio.statusMessage = '正在刷新';
    }
    renderBrowser();
  }

  function reconnectBrowserFrontendAfterRefresh() {
    if (!state.videoMonitor.open || !state.authenticated) return;
    connectBrowser();
    scheduleVideoReconnect({ immediate: true });
    if (state.browser.audio.enabled) scheduleAudioReconnect({ immediate: true });
  }

  async function refreshBrowserProcessAndConnections() {
    const button = $('browser-process-refresh');
    if (!button || button.disabled) return;
    button.disabled = true;
    disconnectBrowserFrontendForRefresh();
    toast('正在刷新 Browser 与前端连接');
    let backendOk = false;
    try {
      const response = await fetch('/mcpmonitor/browser/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok === false || body?.error) {
        throw new Error(body?.message || body?.error || 'HTTP ' + response.status);
      }
      backendOk = true;
    } catch (error) {
      console.warn('Browser backend refresh failed', error);
    } finally {
      reconnectBrowserFrontendAfterRefresh();
      button.disabled = false;
      toast(backendOk ? 'Browser 与前端连接已刷新' : 'Browser 后端刷新失败，已重建前端连接');
    }
  }

  function disconnectNativeFrontendForRefresh() {
    disconnectNativeLive({ keepStatus: true });
    state.nativeLive.status = 'connecting';
    state.nativeLive.statusMessage = '正在刷新';
    renderBrowser();
  }

  function reconnectNativeFrontendAfterRefresh() {
    if (!state.videoMonitor.open || !state.authenticated) return;
    scheduleNativeReconnect({ immediate: true });
  }

  async function refreshNativeProcessAndConnections() {
    const button = $('native-process-refresh');
    if (!button || button.disabled) return;
    button.disabled = true;
    disconnectNativeFrontendForRefresh();
    toast('正在刷新 Native KDE 与前端连接');
    let backendOk = false;
    try {
      const response = await fetch('/mcpmonitor/native/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok === false || body?.error) {
        throw new Error(body?.message || body?.error || 'HTTP ' + response.status);
      }
      backendOk = true;
    } catch (error) {
      console.warn('Native backend refresh failed', error);
    } finally {
      reconnectNativeFrontendAfterRefresh();
      button.disabled = false;
      toast(
        backendOk ? 'Native KDE 与前端连接已刷新' : 'Native KDE 刷新失败，已重建前端连接',
      );
    }
  }

  $('browser-process-refresh').addEventListener('click', refreshBrowserProcessAndConnections);
  $('native-process-refresh').addEventListener('click', refreshNativeProcessAndConnections);
  document.querySelectorAll('.surface-controls').forEach((controls) => {
    for (const type of [
      'pointerdown',
      'pointerup',
      'pointermove',
      'click',
      'contextmenu',
      'keydown',
      'keyup',
    ]) {
      controls.addEventListener(type, (event) => event.stopPropagation());
    }
    controls.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
  });
  let surfaceControlDrag = null;
  const beginSurfaceControlDrag = (surface, handle, event) => {
    if (event.button !== 0 && event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const { zone, controls } = surfaceControlParts(surface);
    if (!zone || !controls || zone.offsetParent === null) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = controls.getBoundingClientRect();
    const scale = uiScaleFactor();
    surfaceControlDrag = {
      surface,
      pointerId: event.pointerId,
      grabX: (Number(event.clientX) - rect.left) / scale,
      grabY: (Number(event.clientY) - rect.top) / scale,
      handle,
    };
    controls.classList.add('dragging');
    controls.style.right = 'auto';
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {}
  };
  const moveSurfaceControlDrag = (event) => {
    const drag = surfaceControlDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const { zone, controls, model } = surfaceControlParts(drag.surface);
    if (!zone || !controls) return;
    event.preventDefault();
    event.stopPropagation();
    const zoneRect = zone.getBoundingClientRect();
    const scale = uiScaleFactor();
    const maxLeft = Math.max(0, zone.clientWidth - controls.offsetWidth);
    const maxTop = Math.max(0, zone.clientHeight - controls.offsetHeight);
    const left = Math.max(
      0,
      Math.min(maxLeft, (Number(event.clientX) - zoneRect.left) / scale - drag.grabX),
    );
    const top = Math.max(
      0,
      Math.min(maxTop, (Number(event.clientY) - zoneRect.top) / scale - drag.grabY),
    );
    controls.style.left = `${Math.round(left)}px`;
    controls.style.top = `${Math.round(top)}px`;
    controls.style.right = 'auto';
    model.controlPosition = {
      x: maxLeft > 0 ? left / maxLeft : 0,
      y: maxTop > 0 ? top / maxTop : 0,
    };
  };
  const finishSurfaceControlDrag = (event) => {
    const drag = surfaceControlDrag;
    if (!drag || (event?.pointerId != null && drag.pointerId !== event.pointerId)) return;
    const { controls } = surfaceControlParts(drag.surface);
    controls?.classList.remove('dragging');
    try {
      drag.handle?.releasePointerCapture(drag.pointerId);
    } catch {}
    surfaceControlDrag = null;
    persistPageState();
  };
  document.querySelectorAll('[data-surface-control-drag]').forEach((handle) => {
    const surface = handle.dataset.surfaceControlDrag === 'native' ? 'native' : 'browser';
    handle.addEventListener('pointerdown', (event) =>
      beginSurfaceControlDrag(surface, handle, event),
    );
    handle.addEventListener('pointermove', moveSurfaceControlDrag);
    handle.addEventListener('pointerup', finishSurfaceControlDrag);
    handle.addEventListener('pointercancel', finishSurfaceControlDrag);
  });
  if (typeof ResizeObserver === 'function') {
    const surfaceControlResizeObserver = new ResizeObserver(() => {
      if (!surfaceControlDrag) syncSurfaceControlPositions();
    });
    surfaceControlResizeObserver.observe($('browser-stage'));
  }
  $('browser-view-toggle').addEventListener('click', () => {
    if (state.nativeLive.surfaceCollapsed) restoreRemoteSplit();
    else setRemoteSurfaceCollapsed('native', true);
  });
  $('native-view-toggle').addEventListener('click', () => {
    if (state.browser.surfaceCollapsed) restoreRemoteSplit();
    else setRemoteSurfaceCollapsed('browser', true);
  });
  $('browser-switch-surface').addEventListener('click', () =>
    setRemoteSurfaceCollapsed('browser', true),
  );
  $('native-switch-surface').addEventListener('click', () =>
    setRemoteSurfaceCollapsed('native', true),
  );
  const browserResizer = $('browser-resizer');
  const finishBrowserPanelResize = (event) => {
    if (!state.videoMonitor.resizingPanel) return;
    if (
      event?.pointerId != null &&
      state.videoMonitor.resizerPointerId != null &&
      event.pointerId !== state.videoMonitor.resizerPointerId
    )
      return;
    state.videoMonitor.resizingPanel = false;
    state.videoMonitor.resizerPointerId = null;
    $('browser-panel').classList.remove('resizing');
    document.documentElement.classList.remove('browser-panel-resizing');
    try {
      browserResizer.releasePointerCapture(event?.pointerId);
    } catch {}
    if (state.mainCollapsed) persistPageState();
    else applyBrowserPanelWidth(state.videoMonitor.panelWidth, { persist: true });
  };
  browserResizer.addEventListener('pointerdown', (event) => {
    if (!state.videoMonitor.open || logicalViewportWidth() <= 720) return;
    event.preventDefault();
    state.videoMonitor.resizingPanel = true;
    state.videoMonitor.resizerPointerId = event.pointerId;
    state.videoMonitor.resizerStartX = Number(event.clientX || 0);
    state.videoMonitor.resizerStartWidth = logicalElementWidth($('browser-panel'));
    $('browser-panel').classList.add('resizing');
    document.documentElement.classList.add('browser-panel-resizing');
    try {
      browserResizer.setPointerCapture(event.pointerId);
    } catch {}
  });
  browserResizer.addEventListener('pointermove', (event) => {
    if (
      !state.videoMonitor.resizingPanel ||
      event.pointerId !== state.videoMonitor.resizerPointerId
    )
      return;
    event.preventDefault();
    const delta =
      (state.videoMonitor.resizerStartX - Number(event.clientX || 0)) / uiScaleFactor();
    const requestedWidth = state.videoMonitor.resizerStartWidth + delta;
    const sidebarWidth = logicalElementWidth($('sidebar'));
    if (!state.mainCollapsed && mainPaneWouldCollapse(sidebarWidth, requestedWidth)) {
      setMainCollapsed(true, { persist: false });
    }
    if (state.mainCollapsed) {
      const viewportWidth = Math.max(320, logicalViewportWidth());
      applySidebarWidth(Math.max(1, viewportWidth - requestedWidth));
      return;
    }
    applyBrowserPanelWidth(requestedWidth);
  });
  browserResizer.addEventListener('pointerup', finishBrowserPanelResize);
  browserResizer.addEventListener('pointercancel', finishBrowserPanelResize);
  browserResizer.addEventListener('keydown', (event) => {
    if (!state.videoMonitor.open || logicalViewportWidth() <= 720) return;
    const limits = browserPanelLimits();
    const current = logicalElementWidth($('browser-panel'));
    const step = event.shiftKey ? 64 : 24;
    let next = null;
    if (event.key === 'ArrowLeft') next = current + step;
    else if (event.key === 'ArrowRight') next = current - step;
    else if (event.key === 'Home') next = limits.min;
    else if (event.key === 'End') next = limits.max;
    if (next == null) return;
    event.preventDefault();
    applyBrowserPanelWidth(next, { persist: true });
  });
  window.addEventListener('resize', () => {
    if (logicalViewportWidth() <= 720 && state.mainCollapsed)
      setMainCollapsed(false, { persist: true });
    if (state.sidebarWidth > 0) applySidebarWidth(state.sidebarWidth, { persist: true });
    if (!state.mainCollapsed && state.videoMonitor.panelWidth > 0)
      applyBrowserPanelWidth(state.videoMonitor.panelWidth, { persist: true });
    if (!state.mainCollapsed && state.videoMonitor.open && logicalViewportWidth() > 900) {
      const sidebarWidth = logicalElementWidth($('sidebar'));
      const browserWidth = logicalElementWidth($('browser-panel'));
      if (mainPaneWouldCollapse(sidebarWidth, browserWidth))
        setMainCollapsed(true, { persist: true });
    }
    requestAnimationFrame(renderAgentCursor);
  });

  const browserStage = $('browser-stage');
  const browserSurface = $('browser-surface');
  const browserInputSink = $('browser-input-sink');
  let browserCompositionActive = false;
  if (browserInputSink) {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const iosLike =
      /(?:iPad|iPhone|iPod)/.test(ua) ||
      /^(?:iPad|iPhone|iPod)$/.test(platform) ||
      (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const edgeIos = /EdgiOS\//.test(ua);
    browserInputSink.classList.toggle('ios-ime-host', iosLike);
    browserInputSink.classList.toggle('edgios-ime-host', edgeIos);
    document.documentElement.classList.toggle('edgios-ime-page', edgeIos);
  }
  browserSurface.addEventListener('contextmenu', (event) => event.preventDefault());
  browserSurface.addEventListener('dragstart', (event) => event.preventDefault());

  function focusBrowserStage() {
    // One cross-platform keyboard path: the browser always focuses a real
    // editable sink and therefore owns layout, Shift/Caps, dead-key and IME
    // resolution. Pointer input still targets the remote Chromium surface.
    // The sink has a stable on-screen rectangle so native IME candidate UI has
    // one predictable anchor instead of trying to follow the remote caret.
    const target = browserInputSink || browserSurface;
    // Keep focus itself completely ordinary. Edge/iOS is especially strict
    // about editable focus being established synchronously inside the pointer
    // gesture; changing root layout/scroll state before or immediately after
    // focus can make WebKit decline to start the native IME session. Its host
    // is instead kept inside the visible viewport purely with CSS.
    try {
      target.focus({ preventScroll: true });
    } catch {
      try {
        target.focus();
      } catch {}
    }
    if (target === browserInputSink && !browserCompositionActive) {
      browserInputSink.value = '';
      browserInputSink.classList.remove('ime-composing');
      try {
        browserInputSink.setSelectionRange(0, 0);
      } catch {}
    }
  }

  function resetBrowserPointer() {
    state.browser.pointerDown = false;
    state.browser.pointerId = null;
    state.browser.pointerType = null;
    state.browser.pointerStart = null;
    state.browser.pointerLast = null;
    state.browser.pointerStartClient = null;
    state.browser.pointerDragging = false;
  }

  function beginBrowserPointer(event, point) {
    state.browser.pointerDown = true;
    state.browser.pointerId = event.pointerId ?? null;
    state.browser.pointerType = event.pointerType || 'mouse';
    state.browser.pointerButton = pointerButtonName(event.button);
    state.browser.pointerStart = point;
    state.browser.pointerLast = point;
    state.browser.pointerStartClient = {
      x: Number(event.clientX || 0),
      y: Number(event.clientY || 0),
    };
    state.browser.pointerDragging = false;
  }

  function maybeStartBrowserDrag(event, point) {
    if (
      !state.browser.pointerDown ||
      state.browser.pointerDragging ||
      !state.browser.pointerStartClient
    )
      return false;
    const dx = Number(event.clientX || 0) - state.browser.pointerStartClient.x;
    const dy = Number(event.clientY || 0) - state.browser.pointerStartClient.y;
    const threshold = state.browser.pointerType === 'touch' ? 9 : 4;
    if (dx * dx + dy * dy < threshold * threshold) return false;
    state.browser.pointerDragging = true;
    sendBrowserMouse({
      action: 'down',
      button: state.browser.pointerButton,
      ...state.browser.pointerStart,
    });
    if (point) sendBrowserMouse({ action: 'move', ...point });
    return true;
  }

  browserSurface.addEventListener('pointerdown', (event) => {
    const point = normalizedBrowserPoint(event);
    if (!point) return;
    event.preventDefault();
    focusBrowserStage();
    beginBrowserPointer(event, point);
    try {
      browserSurface.setPointerCapture(event.pointerId);
    } catch {}
  });
  browserSurface.addEventListener('pointermove', (event) => {
    const point = normalizedBrowserPoint(event);
    if (
      state.browser.pointerDown &&
      state.browser.pointerId != null &&
      event.pointerId !== state.browser.pointerId
    )
      return;
    if (!point) return;
    state.browser.pointerLast = point;
    if (state.browser.pointerDown) {
      event.preventDefault();
      if (!maybeStartBrowserDrag(event, point) && state.browser.pointerDragging) {
        sendBrowserMouse({ action: 'move', ...point });
      }
    } else if ((event.pointerType || 'mouse') !== 'touch') {
      queueBrowserMove(point);
    }
  });
  const finishBrowserPointer = (event) => {
    if (!state.browser.pointerDown) return;
    if (state.browser.pointerId != null && event.pointerId !== state.browser.pointerId) return;
    const point =
      normalizedBrowserPoint(event) || state.browser.pointerLast || state.browser.pointerStart;
    const dragging = state.browser.pointerDragging;
    const button = state.browser.pointerButton;
    try {
      browserSurface.releasePointerCapture(event.pointerId);
    } catch {}
    if (point) {
      event.preventDefault();
      if (dragging) {
        sendBrowserMouse({ action: 'up', button, ...point });
      } else {
        sendBrowserMouse({ action: 'click', button, clickCount: 1, ...point });
        state.browser.lastPointerClickAt = performance.now();
      }
    }
    resetBrowserPointer();
  };
  browserSurface.addEventListener('pointerup', finishBrowserPointer);
  browserSurface.addEventListener('pointercancel', () => {
    if (state.browser.pointerDown && state.browser.pointerDragging && state.browser.pointerLast) {
      sendBrowserMouse({
        action: 'up',
        button: state.browser.pointerButton,
        ...state.browser.pointerLast,
      });
    }
    resetBrowserPointer();
  });
  browserSurface.addEventListener('lostpointercapture', (event) => {
    const pointerId = event.pointerId;
    queueMicrotask(() => {
      // A normal pointerup explicitly releases capture and resets state in the
      // same task. Only repair an unexpected loss that left a drag active.
      if (!state.browser.pointerDown) return;
      if (state.browser.pointerId != null && pointerId !== state.browser.pointerId) return;
      if (state.browser.pointerDragging && state.browser.pointerLast) {
        sendBrowserMouse({
          action: 'up',
          button: state.browser.pointerButton,
          ...state.browser.pointerLast,
        });
      }
      resetBrowserPointer();
    });
  });

  // Some iPadOS/Safari input paths (notably external trackpads) can surface a
  // final click even when the preceding Pointer Events are incomplete. Treat
  // it as a fallback only; normal pointerup-generated clicks are suppressed by
  // the short de-duplication window.
  browserSurface.addEventListener('click', (event) => {
    if (performance.now() - state.browser.lastPointerClickAt < 700) return;
    const point = normalizedBrowserPoint(event);
    if (!point) return;
    event.preventDefault();
    sendBrowserMouse({
      action: 'click',
      button: pointerButtonName(event.button),
      clickCount: 1,
      ...point,
    });
    state.browser.lastPointerClickAt = performance.now();
  });

  // WebKit fallback for environments without Pointer Events keeps taps and
  // drags usable instead of turning the viewport into a passive image.
  if (!window.PointerEvent) {
    const touchLikeEvent = (touch) => ({
      clientX: touch?.clientX ?? 0,
      clientY: touch?.clientY ?? 0,
      button: 0,
      pointerId: 1,
      pointerType: 'touch',
    });
    browserSurface.addEventListener(
      'touchstart',
      (event) => {
        if (event.touches.length !== 1) return;
        const synthetic = touchLikeEvent(event.touches[0]);
        const point = normalizedBrowserPoint(synthetic);
        if (!point) return;
        event.preventDefault();
        focusBrowserStage();
        beginBrowserPointer(synthetic, point);
      },
      { passive: false },
    );
    browserSurface.addEventListener(
      'touchmove',
      (event) => {
        if (!state.browser.pointerDown || event.touches.length !== 1) return;
        const synthetic = touchLikeEvent(event.touches[0]);
        const point = normalizedBrowserPoint(synthetic);
        if (!point) return;
        event.preventDefault();
        state.browser.pointerLast = point;
        if (!maybeStartBrowserDrag(synthetic, point) && state.browser.pointerDragging) {
          sendBrowserMouse({ action: 'move', ...point });
        }
      },
      { passive: false },
    );
    browserSurface.addEventListener(
      'touchend',
      (event) => {
        if (!state.browser.pointerDown) return;
        const synthetic = touchLikeEvent(event.changedTouches[0]);
        const point =
          normalizedBrowserPoint(synthetic) ||
          state.browser.pointerLast ||
          state.browser.pointerStart;
        const dragging = state.browser.pointerDragging;
        const button = state.browser.pointerButton;
        if (point) {
          event.preventDefault();
          browserSend({
            type: 'input',
            event: {
              kind: 'mouse',
              native: true,
              action: dragging ? 'up' : 'click',
              button,
              ...(dragging ? {} : { clickCount: 1 }),
              ...point,
            },
          });
        }
        resetBrowserPointer();
      },
      { passive: false },
    );
    browserSurface.addEventListener(
      'touchcancel',
      () => {
        if (
          state.browser.pointerDown &&
          state.browser.pointerDragging &&
          state.browser.pointerLast
        ) {
          browserSend({
            type: 'input',
            event: {
              kind: 'mouse',
              native: true,
              action: 'up',
              button: state.browser.pointerButton,
              ...state.browser.pointerLast,
            },
          });
        }
        resetBrowserPointer();
      },
      { passive: false },
    );
  }
  browserSurface.addEventListener(
    'wheel',
    (event) => {
      const point = normalizedBrowserPoint(event);
      if (!point) return;
      event.preventDefault();
      focusBrowserStage();
      // Precision touchpads (notably desktop Edge on Windows) can emit wheel
      // events much faster than the remote control path needs. The bounded
      // 120-Hz queue below avoids both event floods and stale scroll debt.
      // Normalize WheelEvent units before they enter the Sunshine-style input
      // batching path. Pixel-mode precision scrolling stays high-resolution;
      // line/page modes are converted to stable wheel units so browser/OS
      // differences do not explode or starve the remote wheel accumulator.
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 40
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? 800
            : 1;
      queueBrowserWheel(
        point,
        event.deltaX * unit * BROWSER_WHEEL_SENSITIVITY,
        event.deltaY * unit * BROWSER_WHEEL_SENSITIVITY,
      );
    },
    { passive: false },
  );
  function sendBrowserNativeText(text) {
    text = String(text ?? '');
    if (!text) return;
    browserSend({
      type: 'input',
      event: { kind: 'key', native: true, action: 'type', text, route: 'native' },
    });
  }

  // Keyboard transport is intentionally semantic and platform-neutral. Text
  // is emitted only from the editable sink's input/composition pipeline. Keys
  // which do not produce text are emitted as short atomic native chords. This
  // avoids trying to reconstruct characters from KeyboardEvent.key/code on any
  // client (Windows, macOS, iPadOS, IMEs, dead keys, alternate layouts, ...).
  const BROWSER_MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph']);
  const BROWSER_LOCAL_INPUT_KEYS = new Set([
    'CapsLock',
    'Globe',
    'Fn',
    'Process',
    'Dead',
    'Unidentified',
    'ModeChange',
    'KanaMode',
    'KanjiMode',
    'HangulMode',
    'HanjaMode',
    'Convert',
    'NonConvert',
    'Alphanumeric',
    'ZenkakuHankaku',
  ]);
  let browserCompositionDuplicateText = '';
  let browserCompositionDuplicateTimer = 0;
  let browserPendingCompositionCommit = '';
  let browserBeforeInputCommitText = '';
  let browserBeforeInputCommitTimer = 0;
  const browserPrintableFallbacks = [];

  function clearBrowserPrintableFallbacks() {
    while (browserPrintableFallbacks.length) {
      const pending = browserPrintableFallbacks.shift();
      clearTimeout(pending.timer);
    }
  }

  function cancelBrowserPrintableFallback(text = '') {
    text = String(text ?? '');
    if (!browserPrintableFallbacks.length) return;

    // Normal editable controls emit one input event per hardware key. Match
    // that event to the oldest queued KeyboardEvent fallback. For the rarer
    // case where WebKit batches several characters into one insertText, consume
    // the same number of single-character fallbacks from the queue.
    if (text.length > 1) {
      let prefix = '';
      let count = 0;
      for (const pending of browserPrintableFallbacks) {
        prefix += pending.text;
        count += 1;
        if (prefix === text) {
          for (let i = 0; i < count; ++i) {
            const matched = browserPrintableFallbacks.shift();
            clearTimeout(matched.timer);
          }
          return;
        }
        if (!text.startsWith(prefix)) break;
      }
    }

    const index = browserPrintableFallbacks.findIndex((pending) => pending.text === text);
    if (index < 0) return;
    const [matched] = browserPrintableFallbacks.splice(index, 1);
    clearTimeout(matched.timer);
  }

  function scheduleBrowserPrintableFallback(event) {
    const key = String(event.key || '');
    if (key.length !== 1) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    // Safari on iPadOS can deliver the resolved printable key on keydown while
    // failing to mutate a programmatically-focused, visually hidden textarea.
    // Function keys still work in that state, which is exactly the failure mode
    // seen by mcpmonitor: printable keydowns were deliberately ignored while we
    // waited forever for an input event. Give the editable path one task to win;
    // if no matching input arrives, forward KeyboardEvent.key as literal text.
    const pending = { text: key, timer: 0 };
    pending.timer = setTimeout(() => {
      const index = browserPrintableFallbacks.indexOf(pending);
      if (index < 0) return;
      browserPrintableFallbacks.splice(index, 1);
      if (!browserCompositionActive) sendBrowserNativeText(key);
    }, 24);
    browserPrintableFallbacks.push(pending);
  }

  function browserEventIsComposing(event) {
    const key = String(event.key || '');
    // iPadOS Safari reports keyCode/which=229 for ordinary hardware-keyboard
    // printable keys too. Treating 229 itself as IME state makes every normal
    // key look like an unfinished composition. The composition events are the
    // authoritative lifetime; event.isComposing covers the key event which
    // starts a composition before compositionstart has reached us.
    return (
      browserCompositionActive ||
      event.isComposing === true ||
      ['Process', 'Dead', 'Unidentified'].includes(key)
    );
  }

  function browserLocalInputControl(event) {
    const key = String(event.key || '');
    const code = String(event.code || '');
    const space = key === ' ' || key === 'Spacebar' || code === 'Space';
    // Input-source switches must stay on the client. This covers the common
    // Ctrl/Command+Space mechanisms without any OS-specific branch.
    if (space && (event.ctrlKey || event.metaKey)) return true;
    return BROWSER_LOCAL_INPUT_KEYS.has(key);
  }

  function browserTextProducingKey(event) {
    if (browserEventIsComposing(event)) return true;
    const key = String(event.key || '');
    if (typeof event.getModifierState === 'function' && event.getModifierState('AltGraph'))
      return true;
    // Plain printable keys, including Shift/Caps-resolved punctuation, are left
    // entirely to the local browser's editable/input machinery.
    return key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
  }

  function sendBrowserNativeKeyStroke(key, modifiers = {}) {
    key = String(key || '');
    if (!key || key === 'Unidentified' || BROWSER_MODIFIER_KEYS.has(key)) return;
    const active = [];
    if (modifiers.ctrlKey) active.push('Control');
    if (modifiers.altKey) active.push('Alt');
    if (modifiers.metaKey) active.push('Meta');
    if (modifiers.shiftKey) active.push('Shift');
    for (const modifier of active) {
      browserSend({
        type: 'input',
        event: { kind: 'key', native: true, action: 'down', key: modifier },
      });
    }
    browserSend({ type: 'input', event: { kind: 'key', native: true, action: 'down', key } });
    browserSend({ type: 'input', event: { kind: 'key', native: true, action: 'up', key } });
    for (let i = active.length - 1; i >= 0; --i) {
      browserSend({
        type: 'input',
        event: { kind: 'key', native: true, action: 'up', key: active[i] },
      });
    }
  }

  function clearBrowserCompositionDuplicate() {
    if (browserCompositionDuplicateTimer) clearTimeout(browserCompositionDuplicateTimer);
    browserCompositionDuplicateTimer = 0;
    browserCompositionDuplicateText = '';
  }

  function clearBrowserBeforeInputCommit() {
    if (browserBeforeInputCommitTimer) clearTimeout(browserBeforeInputCommitTimer);
    browserBeforeInputCommitTimer = 0;
    browserBeforeInputCommitText = '';
  }

  function rememberBrowserBeforeInputCommit(text) {
    clearBrowserBeforeInputCommit();
    browserBeforeInputCommitText = String(text ?? '');
    if (!browserBeforeInputCommitText) return;
    browserBeforeInputCommitTimer = setTimeout(() => {
      browserBeforeInputCommitTimer = 0;
      browserBeforeInputCommitText = '';
    }, 120);
  }

  function commitBrowserSinkText(text) {
    text = String(text ?? '');
    if (text) sendBrowserNativeText(text);
    if (browserInputSink) browserInputSink.value = '';
  }

  function handleBrowserInputKeyDown(event) {
    if (browserLocalInputControl(event) || browserEventIsComposing(event)) return;
    if (BROWSER_MODIFIER_KEYS.has(String(event.key || ''))) return;
    if (browserTextProducingKey(event)) {
      scheduleBrowserPrintableFallback(event);
      return;
    }

    // Everything which is not local text production is a remote semantic key
    // or shortcut. Emit a complete chord immediately; never keep remote
    // modifiers latched waiting for a browser-specific keyup sequence.
    event.preventDefault();
    sendBrowserNativeKeyStroke(event.key, event);
  }

  function handleBrowserInputKeyUp(event) {
    if (browserLocalInputControl(event) || browserEventIsComposing(event)) return;
    if (BROWSER_MODIFIER_KEYS.has(String(event.key || '')) || browserTextProducingKey(event))
      return;
    // The matching remote key was already emitted atomically on keydown.
    event.preventDefault();
  }

  // Listen once on the browser surface. Events from the nested editable sink bubble here,
  // avoiding the double-delivery bug caused by registering the same handler on
  // both elements.
  browserSurface.addEventListener('keydown', handleBrowserInputKeyDown);
  browserSurface.addEventListener('keyup', handleBrowserInputKeyUp);

  if (browserInputSink) {
    browserInputSink.addEventListener('beforeinput', (event) => {
      const inputType = String(event.inputType || '');
      const data = event.data == null ? '' : String(event.data);

      // WebKit's text system is a better authority than KeyboardEvent.key for
      // IME-resolved punctuation. In particular, iPad Safari may expose a
      // Chinese punctuation glyph on keydown even after the local input mode
      // has switched punctuation style, while beforeinput carries the actual
      // text the editor intends to insert. Consume ordinary insertText here so
      // the 24 ms keydown fallback is only a last resort for browsers which do
      // not produce editable events at all.
      if (!browserCompositionActive && !event.isComposing && inputType === 'insertText' && data) {
        cancelBrowserPrintableFallback(data);
        if (event.cancelable) event.preventDefault();
        commitBrowserSinkText(data);
        // Some WebKit builds can still emit the paired input event when a
        // beforeinput path is not cancelable. Suppress only the immediately
        // matching insertText so this remains safe across Safari/Edge iOS.
        rememberBrowserBeforeInputCommit(data);
        return;
      }

      if (browserCompositionActive && inputType === 'insertFromComposition' && data) {
        browserPendingCompositionCommit = data;
        cancelBrowserPrintableFallback(data);
      }
    });

    browserInputSink.addEventListener('compositionstart', () => {
      clearBrowserPrintableFallbacks();
      clearBrowserBeforeInputCommit();
      browserCompositionActive = true;
      browserPendingCompositionCommit = '';
      clearBrowserCompositionDuplicate();
      // Do not mutate the textarea value once native composition has started:
      // WebKit owns the preedit buffer and candidate selection from here until
      // compositionend. Making the host visible only while composing also
      // gives iPadOS a stable, understandable place to draw the IME UI.
      browserInputSink.classList.add('ime-composing');
    });

    browserInputSink.addEventListener('compositionupdate', () => {
      browserInputSink.classList.add('ime-composing');
    });

    browserInputSink.addEventListener('compositionend', (event) => {
      browserCompositionActive = false;
      const eventText = event.data == null ? '' : String(event.data);
      const sinkText = String(browserInputSink.value || '');
      // WebKit/iPadOS can expose the committed string on the preceding
      // insertFromComposition input (or only in the textarea value) while
      // compositionend.data itself is empty. Preserve that commit instead of
      // clearing it as an empty composition.
      const text = eventText || browserPendingCompositionCommit || sinkText;
      browserPendingCompositionCommit = '';
      // compositionend is the authoritative commit boundary. Safari/iPadOS
      // emits insertFromComposition *before* compositionend, while Chromium
      // may emit a final input after it. Commit here immediately so a fast next
      // keystroke cannot overtake the composition, then suppress only a
      // composition-flavoured duplicate that follows shortly afterwards.
      commitBrowserSinkText(text);
      browserInputSink.classList.remove('ime-composing');
      clearBrowserCompositionDuplicate();
      if (text) {
        browserCompositionDuplicateText = text;
        browserCompositionDuplicateTimer = setTimeout(() => {
          browserCompositionDuplicateTimer = 0;
          browserCompositionDuplicateText = '';
        }, 120);
      }
    });

    browserInputSink.addEventListener('input', (event) => {
      const inputType = String(event.inputType || '');
      const data = event.data == null ? '' : String(event.data);
      if (data) cancelBrowserPrintableFallback(data);

      if (browserBeforeInputCommitText) {
        if (inputType === 'insertText' && data === browserBeforeInputCommitText) {
          clearBrowserBeforeInputCommit();
          browserInputSink.value = '';
          return;
        }
        clearBrowserBeforeInputCommit();
      }

      if (browserCompositionActive) {
        // Safari emits the committed insertFromComposition while composition
        // is still active, before compositionend. Remember only that final
        // commit; intermediate insertCompositionText values stay local.
        if (inputType === 'insertFromComposition' && data) {
          browserPendingCompositionCommit = data;
        }
        return;
      }

      // Do not reject an input merely because InputEvent.isComposing is true.
      // iPadOS can keep that flag set on a hardware-keyboard insertText even
      // without an active composition. A real composition is gated above by
      // compositionstart/compositionend, so ordinary printable text must be
      // allowed to commit here.

      if (browserCompositionDuplicateText) {
        const compositionLike =
          inputType === 'insertFromComposition' || inputType === 'insertCompositionText';
        if (compositionLike && data === browserCompositionDuplicateText) {
          clearBrowserCompositionDuplicate();
          browserInputSink.value = '';
          return;
        }
        clearBrowserCompositionDuplicate();
      }

      if (inputType === 'deleteContentBackward') {
        browserInputSink.value = '';
        sendBrowserNativeKeyStroke('Backspace');
        return;
      }
      if (inputType === 'deleteContentForward') {
        browserInputSink.value = '';
        sendBrowserNativeKeyStroke('Delete');
        return;
      }
      if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') {
        browserInputSink.value = '';
        sendBrowserNativeKeyStroke('Enter');
        return;
      }

      // For normal typing, paste, replacement text, dictation and other text
      // producers, prefer InputEvent.data and fall back to the sink's mutation.
      const text = data || String(browserInputSink.value || '');
      commitBrowserSinkText(text);
    });

    browserInputSink.addEventListener('blur', () => {
      clearBrowserPrintableFallbacks();
      clearBrowserBeforeInputCommit();
      clearBrowserCompositionDuplicate();
      browserCompositionActive = false;
      browserPendingCompositionCommit = '';
      browserInputSink.value = '';
      browserInputSink.classList.remove('ime-composing');
      releaseBrowserKeys();
    });
  }

  const nativeSurface = $('native-surface');
  let suppressNativeCaptureShortcutKeyUp = false;
  let nativeCaptureFullscreenOwned = false;
  let nativeCaptureKeyboardLocked = false;
  let nativeCaptureEnhancementEpoch = 0;

  function nativeCaptureShortcut(event) {
    return (
      event.code === 'KeyZ' && event.ctrlKey && event.altKey && event.shiftKey && !event.metaKey
    );
  }

  function nativeBrowserFullscreenActive() {
    if (document.fullscreenElement) return false;
    if (window.fullScreen === true) return true;
    const screenWidth = Number(window.screen?.width || 0);
    const screenHeight = Number(window.screen?.height || 0);
    if (!screenWidth || !screenHeight) return false;
    const candidates = [
      [Number(window.outerWidth || 0), Number(window.outerHeight || 0)],
      [Number(window.innerWidth || 0), Number(window.innerHeight || 0)],
      [
        Number(window.visualViewport?.width || 0),
        Number(window.visualViewport?.height || 0),
      ],
    ];
    return candidates.some(
      ([width, height]) =>
        width > 0 &&
        height > 0 &&
        Math.abs(width - screenWidth) <= 3 &&
        Math.abs(height - screenHeight) <= 3,
    );
  }

  function reportNativeCaptureTelemetry(event, detail = {}) {
    fetch('/mcpmonitor/api/video-telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        backend: 'native-input-capture',
        event,
        pointer_locked: document.pointerLockElement === nativeSurface,
        js_fullscreen: !!document.fullscreenElement,
        window_fullscreen: window.fullScreen === true,
        outer_width: Number(window.outerWidth || 0),
        outer_height: Number(window.outerHeight || 0),
        inner_width: Number(window.innerWidth || 0),
        inner_height: Number(window.innerHeight || 0),
        screen_width: Number(window.screen?.width || 0),
        screen_height: Number(window.screen?.height || 0),
        keyboard_lock_api: typeof navigator.keyboard?.lock === 'function',
        ...detail,
      }),
      cache: 'no-store',
      keepalive: true,
    }).catch(() => {});
  }

  async function lockNativeEscapeIfEligible(epoch) {
    if (
      epoch !== nativeCaptureEnhancementEpoch ||
      document.pointerLockElement !== nativeSurface ||
      !document.fullscreenElement ||
      typeof navigator.keyboard?.lock !== 'function'
    )
      return;
    try {
      await navigator.keyboard.lock(['Escape']);
      if (epoch === nativeCaptureEnhancementEpoch) nativeCaptureKeyboardLocked = true;
      else navigator.keyboard?.unlock?.();
    } catch (error) {
      console.warn('Native keyboard lock unavailable', error);
    }
  }

  function maybeEnableNativeEscapeCapture() {
    const browserFullscreen = nativeBrowserFullscreenActive();
    if (!browserFullscreen || typeof document.documentElement.requestFullscreen !== 'function') {
      reportNativeCaptureTelemetry('escape-enhancement-skipped', {
        browser_fullscreen_detected: browserFullscreen,
      });
      return;
    }
    const epoch = ++nativeCaptureEnhancementEpoch;
    reportNativeCaptureTelemetry('escape-enhancement-start', {
      browser_fullscreen_detected: true,
    });

    // Chromium permits a keyboard-lock request to be registered while the
    // browser is in F11 fullscreen. It remains inactive there and becomes
    // active when this document enters JS fullscreen. Register it before the
    // fullscreen transition, while we are still in the shortcut user gesture.
    if (typeof navigator.keyboard?.lock === 'function') {
      try {
        const keyboardRequest = navigator.keyboard.lock(['Escape']);
        Promise.resolve(keyboardRequest)
          .then(() => {
            if (epoch !== nativeCaptureEnhancementEpoch) {
              navigator.keyboard?.unlock?.();
              return;
            }
            nativeCaptureKeyboardLocked = true;
            reportNativeCaptureTelemetry('keyboard-lock-registered');
          })
          .catch((error) => {
            reportNativeCaptureTelemetry('keyboard-lock-register-failed', {
              error: String(error?.name || error || 'unknown'),
            });
          });
      } catch (error) {
        reportNativeCaptureTelemetry('keyboard-lock-register-failed', {
          error: String(error?.name || error || 'unknown'),
        });
      }
    }
    try {
      const fullscreenRequest = document.documentElement.requestFullscreen({
        navigationUI: 'hide',
      });
      Promise.resolve(fullscreenRequest)
        .then(() => {
          if (epoch !== nativeCaptureEnhancementEpoch) return;
          nativeCaptureFullscreenOwned =
            document.fullscreenElement === document.documentElement;
          reportNativeCaptureTelemetry('js-fullscreen-entered', {
            owned: nativeCaptureFullscreenOwned,
          });
          void lockNativeEscapeIfEligible(epoch);
        })
        .catch((error) => {
          console.warn('Native fullscreen keyboard-lock enhancement unavailable', error);
          reportNativeCaptureTelemetry('js-fullscreen-failed', {
            error: String(error?.name || error || 'unknown'),
          });
        });
    } catch (error) {
      console.warn('Native fullscreen keyboard-lock enhancement unavailable', error);
      reportNativeCaptureTelemetry('js-fullscreen-failed', {
        error: String(error?.name || error || 'unknown'),
      });
    }
  }

  function clearNativeEscapeCapture() {
    nativeCaptureEnhancementEpoch += 1;
    if (nativeCaptureKeyboardLocked) {
      try {
        navigator.keyboard?.unlock?.();
      } catch {}
      nativeCaptureKeyboardLocked = false;
    }
    const shouldExitOwnedFullscreen =
      nativeCaptureFullscreenOwned && document.fullscreenElement === document.documentElement;
    nativeCaptureFullscreenOwned = false;
    if (shouldExitOwnedFullscreen) {
      try {
        const exitRequest = document.exitFullscreen?.();
        exitRequest?.catch?.((error) =>
          console.warn('Native owned fullscreen cleanup failed', error),
        );
      } catch (error) {
        console.warn('Native owned fullscreen cleanup failed', error);
      }
    }
  }

  function leaveNativeMouseCapture() {
    releaseNativeInput();
    if (document.pointerLockElement === nativeSurface) document.exitPointerLock?.();
    clearNativeEscapeCapture();
  }

  function nativeMouseCaptureCanEnter() {
    // "Native fullscreen" in this UI means the Native surface is maximized
    // and the Browser surface is collapsed. Leaving capture is intentionally
    // allowed from every layout state.
    return state.browser.surfaceCollapsed && !state.nativeLive.surfaceCollapsed;
  }

  function enterNativeMouseCapture({ enhanceEscape = false } = {}) {
    if (state.nativeLive.status !== 'online' || !nativeMouseCaptureCanEnter()) return;
    releaseNativeInput();
    try {
      nativeSurface.focus({ preventScroll: true });
    } catch {
      nativeSurface.focus();
    }
    try {
      const pointerRequest = nativeSurface.requestPointerLock?.();
      pointerRequest?.catch?.((error) => console.warn('Native pointer lock failed', error));
    } catch (error) {
      console.warn('Native pointer lock failed', error);
    }
    // This is a best-effort capability side path. It never gates Pointer Lock.
    // If the user already put Chromium into browser fullscreen (F11), upgrade
    // the document to Fullscreen API so Keyboard Lock can reserve Escape for
    // the remote desktop. The page's own Native-panel maximize state is
    // intentionally unrelated.
    if (enhanceEscape) maybeEnableNativeEscapeCapture();
    if (enhanceEscape) reportNativeCaptureTelemetry('capture-shortcut');
  }

  function toggleNativeMouseCapture({ enhanceEscape = false } = {}) {
    if (document.pointerLockElement === nativeSurface) leaveNativeMouseCapture();
    else if (nativeMouseCaptureCanEnter()) enterNativeMouseCapture({ enhanceEscape });
  }

  // Ctrl+Alt+Shift+Z is intentionally handled in the capture phase so the
  // shortcut itself is never sent to the remote machine. Modifier keydowns may
  // already have been sent before KeyZ arrives; releaseNativeInput() below
  // clears them atomically so the remote side cannot be left with stuck keys.
  document.addEventListener(
    'keydown',
    (event) => {
      if (nativeCaptureShortcut(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat) return;
        suppressNativeCaptureShortcutKeyUp = true;
        toggleNativeMouseCapture({ enhanceEscape: true });
        return;
      }
    },
    true,
  );
  document.addEventListener(
    'keyup',
    (event) => {
      if (!suppressNativeCaptureShortcutKeyUp || event.code !== 'KeyZ') return;
      suppressNativeCaptureShortcutKeyUp = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  function nativeContentRect() {
    const native = state.nativeLive;
    const rect = (native.renderer?.canvas || $('native-surface')).getBoundingClientRect();
    const vw = native.width || 1920;
    const vh = native.height || 1080;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const width = vw * scale;
    const height = vh * scale;
    return {
      left: rect.left + (rect.width - width) / 2,
      top: rect.top + (rect.height - height) / 2,
      width,
      height,
      vw,
      vh,
    };
  }

  function normalizedNativePoint(event) {
    const rect = nativeContentRect();
    if (!rect.width || !rect.height || state.nativeLive.status !== 'online') return null;
    if (
      event.clientX < rect.left ||
      event.clientY < rect.top ||
      event.clientX >= rect.left + rect.width ||
      event.clientY >= rect.top + rect.height
    )
      return null;
    return {
      x: Math.max(0, Math.min(rect.vw - 1, ((event.clientX - rect.left) * rect.vw) / rect.width)),
      y: Math.max(0, Math.min(rect.vh - 1, ((event.clientY - rect.top) * rect.vh) / rect.height)),
    };
  }

  function queueNativeMotion(message) {
    const native = state.nativeLive;
    if (!native.pendingMotion || message.t === 'm') native.pendingMotion = message;
    else if (message.t === 'mr' && native.pendingMotion.t === 'mr') {
      native.pendingMotion.dx += message.dx;
      native.pendingMotion.dy += message.dy;
    } else native.pendingMotion = message;
    if (native.motionRaf) return;
    native.motionRaf = requestAnimationFrame(() => {
      native.motionRaf = 0;
      const next = native.pendingMotion;
      native.pendingMotion = null;
      if (next) nativeSend(next);
    });
  }

  nativeSurface.addEventListener('contextmenu', (event) => event.preventDefault());
  nativeSurface.addEventListener('auxclick', (event) => event.preventDefault());
  for (const type of ['mousedown', 'mouseup', 'contextmenu', 'auxclick']) {
    document.addEventListener(
      type,
      (event) => {
        if (
          document.pointerLockElement !== nativeSurface &&
          event.target !== nativeSurface &&
          !nativeSurface.contains(event.target)
        )
          return;
        if (type === 'mousedown' || type === 'mouseup') {
          if (event.button === 0) return;
        }
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
      },
      true,
    );
  }
  nativeSurface.addEventListener('pointerdown', (event) => {
    if (state.nativeLive.status !== 'online') return;
    event.preventDefault();
    try {
      nativeSurface.focus({ preventScroll: true });
    } catch {
      nativeSurface.focus();
    }
    if (document.pointerLockElement !== nativeSurface) {
      const point = normalizedNativePoint(event);
      if (point) nativeSend({ t: 'm', ...point });
    }
    nativeSend({ t: 'b', button: event.button, down: true });
    state.nativeLive.pointerId = event.pointerId;
    try {
      nativeSurface.setPointerCapture(event.pointerId);
    } catch {}
  });
  nativeSurface.addEventListener('pointerup', (event) => {
    if (state.nativeLive.status !== 'online') return;
    event.preventDefault();
    nativeSend({ t: 'b', button: event.button, down: false });
    state.nativeLive.pointerId = null;
    try {
      nativeSurface.releasePointerCapture(event.pointerId);
    } catch {}
  });
  nativeSurface.addEventListener('pointercancel', () => {
    state.nativeLive.pointerId = null;
    nativeSend({ t: 'reset' });
  });
  nativeSurface.addEventListener('pointermove', (event) => {
    if (state.nativeLive.status !== 'online') return;
    if (document.pointerLockElement === nativeSurface) {
      queueNativeMotion({ t: 'mr', dx: event.movementX || 0, dy: event.movementY || 0 });
      return;
    }
    const point = normalizedNativePoint(event);
    if (point) queueNativeMotion({ t: 'm', ...point });
  });
  nativeSurface.addEventListener(
    'wheel',
    (event) => {
      if (state.nativeLive.status !== 'online') return;
      event.preventDefault();
      try {
        nativeSurface.focus({ preventScroll: true });
      } catch {
        nativeSurface.focus();
      }
      nativeSend({
        t: 'w',
        dx: Math.max(-60, Math.min(60, Number(event.deltaX || 0) / 8)),
        dy: Math.max(-60, Math.min(60, Number(event.deltaY || 0) / 8)),
      });
    },
    { passive: false },
  );
  nativeSurface.addEventListener('keydown', (event) => {
    if (state.nativeLive.status !== 'online') return;
    event.preventDefault();
    if (event.repeat) return;
    state.nativeLive.pressedKeys.add(event.code);
    nativeSend({ t: 'k', code: event.code, down: true });
  });
  nativeSurface.addEventListener('keyup', (event) => {
    if (state.nativeLive.status !== 'online') return;
    event.preventDefault();
    state.nativeLive.pressedKeys.delete(event.code);
    nativeSend({ t: 'k', code: event.code, down: false });
  });
  $('native-relative').addEventListener('click', () => {
    toggleNativeMouseCapture();
  });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === nativeSurface;
    reportNativeCaptureTelemetry('pointer-lock-change', { locked });
    nativeSurface.classList.toggle('pointer-locked', locked);
    if (!locked) {
      releaseNativeInput();
      clearNativeEscapeCapture();
    } else if (nativeCaptureFullscreenOwned) {
      void lockNativeEscapeIfEligible(nativeCaptureEnhancementEpoch);
    }
    renderNativeCursorOverlay();
    renderBrowser();
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      nativeCaptureFullscreenOwned = false;
      if (nativeCaptureKeyboardLocked) {
        try {
          navigator.keyboard?.unlock?.();
        } catch {}
        nativeCaptureKeyboardLocked = false;
      }
    }
  });
  window.addEventListener('resize', renderNativeCursorOverlay);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'open-user-input' && message.id) {
        openUserInputFromLink(message.id);
      } else if (message.type === 'user-input-resolved') {
        if (state.selected === message.request?.id) loadDetail(message.request.id, true);
      }
    });
  }

  document.addEventListener('keydown', (event) => {
    if (document.activeElement === browserStage || browserStage.contains(document.activeElement))
      return;
    if (event.key === '/' && document.activeElement.tagName !== 'INPUT') {
      event.preventDefault();
      $('search').focus();
    }
    if (event.key === 'Escape') {
      $('search').blur();
      setTimePopover(false);
      $('sidebar').classList.remove('visible');
    }
  });

  function markListHidden() {
    if (!Number.isFinite(state.listSync.hiddenAt)) state.listSync.hiddenAt = Date.now();
  }

  function recoverListAfterForeground({ force = false } = {}) {
    const now = Date.now();
    const hiddenAt = Number.isFinite(state.listSync.hiddenAt) ? state.listSync.hiddenAt : null;
    const hiddenFor = hiddenAt == null ? 0 : Math.max(0, now - hiddenAt);
    state.listSync.hiddenAt = null;
    if (!state.authenticated) return;
    const sourceHealthy = state.source?.readyState === EventSource.OPEN;
    if (!force && hiddenFor < 250 && sourceHealthy) return;
    if (!sourceHealthy) {
      state.listSync.foregroundVerifyPending = true;
      if (!['catchup', 'reconciling'].includes(state.listSync.mode)) {
        setListSyncMode('reconnecting');
      }
      return;
    }
    if (now - state.listSync.lastForegroundReconcileAt < 250) return;
    state.listSync.lastForegroundReconcileAt = now;
    scheduleListHeadVerify('foreground');
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      markListHidden();
      releaseBrowserKeys();
      releaseNativeInput();
      suspendBrowserConnections();
    } else {
      resumeBrowserConnections({ immediate: true });
      recoverListAfterForeground();
    }
  });
  window.addEventListener('blur', () => {
    releaseBrowserKeys();
    releaseNativeInput();
    if (state.browser.pointerDown && state.browser.pointerDragging && state.browser.pointerLast) {
      sendBrowserMouse({
        action: 'up',
        button: state.browser.pointerButton,
        ...state.browser.pointerLast,
      });
    }
    resetBrowserPointer();
  });
  window.addEventListener('pagehide', () => {
    markListHidden();
    suspendBrowserConnections();
  });
  window.addEventListener('pageshow', () => {
    resumeBrowserConnections({ immediate: true });
    recoverListAfterForeground({ force: true });
  });
  window.addEventListener('focus', () => {
    resumeBrowserConnections({ immediate: true });
    if (Number.isFinite(state.listSync.hiddenAt)) recoverListAfterForeground();
  });
  window.addEventListener('online', () => {
    resumeBrowserConnections({ immediate: true, forceFresh: true });
    recoverListAfterForeground({ force: true });
  });

  // Visibility/focus events are not guaranteed around an OS sleep. A timer
  // that resumes several seconds late is a reliable local signal that this JS
  // realm was suspended. Recover immediately while visible instead of waiting
  // for an RTC state transition that may never be reported.
  setInterval(() => {
    const now = Date.now();
    const gap = Math.max(0, now - state.browser.lifecycleHeartbeatAt);
    state.browser.lifecycleHeartbeatAt = now;
    if (document.visibilityState === 'visible' && gap >= PAGE_SLEEP_RECOVERY_GAP_MS) {
      resumeBrowserConnections({ immediate: true, forceFresh: true });
      recoverListAfterForeground({ force: true });
    }
  }, 1000);

  restorePageStateToControls();
  setTheme({ persist: false });
  setZoom({ persist: false });
  renderSidebar();
  if (state.mainCollapsed) state.videoMonitor.open = true;
  renderMainPane();
  if (state.sidebarWidth > 0) applySidebarWidth(state.sidebarWidth);
  refreshCustomScrollbars();
  updateTimeButton();
  updateFollowButton();
  renderListSync();
  renderConnection();
  renderSessionStats();
  renderDetail();
  if (state.videoMonitor.panelWidth > 0) applyBrowserPanelWidth(state.videoMonitor.panelWidth);
  renderBrowser();
  updateNotificationButton();
  checkAuth();
})();
