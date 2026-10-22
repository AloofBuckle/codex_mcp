(() => {
  'use strict';

  const AV1_CODEC = 'av01.0.10M.08';
  const $ = (id) => document.getElementById(id);
  const viewer = $('viewer');
  const stage = $('stage');
  const canvas = $('canvas');
  const placeholder = $('placeholder');
  const placeholderTitle = $('placeholder-title');
  const status = $('status');
  const statusText = status.querySelector('span');
  const browserInput = $('browser-input');
  const expand = $('expand');
  const relative = $('relative');
  const tabBrowser = $('tab-browser');
  const tabNative = $('tab-native');

  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('token') || '';
  let selected = fragment.get('surface') === 'native' ? 'native' : 'browser';
  history.replaceState(null, '', location.pathname + location.search);

  const state = {
    mode:
      new URLSearchParams(location.search).get('mode') === 'fullscreen' ? 'fullscreen' : 'inline',
    selected,
    generation: 0,
    width: 1920,
    height: 1080,
    pc: null,
    videoDc: null,
    inputDc: null,
    browserWs: null,
    decoder: null,
    assembler: null,
    renderer: null,
    pointerId: null,
    pressedNativeKeys: new Set(),
    moveRaf: 0,
    pendingMove: null,
    wheelRaf: 0,
    pendingWheel: null,
    cursor: { t: 'cursor', x: 0, y: 0, visible: false, shape: 'default', hotspotX: 0, hotspotY: 0 },
    reconnectTimer: 0,
    disconnectTimer: 0,
    resumeTimer: 0,
    resumeForceFresh: false,
    suspendedAt: document.visibilityState === 'hidden' ? Date.now() : null,
    lifecycleHeartbeatAt: Date.now(),
  };
  let nativeCaptureFullscreenOwned = false;
  let nativeCaptureKeyboardLocked = false;
  let nativeCaptureEnhancementEpoch = 0;
  let suppressNativeCaptureShortcutKeyUp = false;

  const PAGE_SLEEP_RECOVERY_GAP_MS = 5000;

  function parentMessage(message) {
    if (window.parent === window) return;
    window.parent.postMessage(message, '*');
  }

  function requestDisplay(mode) {
    parentMessage({ type: 'cua-request-display', mode });
  }

  function requestSession() {
    parentMessage({ type: 'cua-request-session', surface: state.selected });
  }

  function isInteractive() {
    return state.mode === 'fullscreen';
  }

  function setStatus(kind, text) {
    status.classList.toggle('online', kind === 'online');
    status.classList.toggle('error', kind === 'error');
    statusText.textContent = text;
  }

  function setPlaceholder(title, visible) {
    placeholderTitle.textContent = title;
    placeholder.classList.toggle('hidden', visible === false);
  }

  function updateUi() {
    tabBrowser.classList.toggle('active', state.selected === 'browser');
    tabNative.classList.toggle('active', state.selected === 'native');
    tabBrowser.setAttribute('aria-selected', String(state.selected === 'browser'));
    tabNative.setAttribute('aria-selected', String(state.selected === 'native'));
    viewer.classList.toggle('interactive', isInteractive());
    expand.textContent = isInteractive() ? '↙' : '↗';
    expand.title = isInteractive() ? '返回预览' : '展开';
    expand.setAttribute('aria-label', expand.title);
    relative.classList.toggle('hidden', state.selected !== 'native' || !isInteractive());
    if (!isInteractive()) {
      browserInput.blur();
      try {
        if (document.pointerLockElement === stage) document.exitPointerLock();
      } catch {}
    }
  }

  function authHeaders(extra) {
    return Object.assign({}, extra || {}, { authorization: 'Bearer ' + token });
  }

  async function authFetch(path, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = authHeaders(opts.headers);
    opts.cache = 'no-store';
    const response = await fetch(path, opts);
    if (response.status === 401 || response.status === 403) requestSession();
    return response;
  }

  function waitIce(pc, timeout) {
    timeout = timeout || 2500;
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      let timer = 0;
      const finish = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', done);
        resolve();
      };
      const done = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      pc.addEventListener('icegatheringstatechange', done);
      timer = setTimeout(finish, timeout);
    });
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'shader compile failed';
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function createRenderer(target) {
    const gl = target.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      const ctx = target.getContext('2d', { alpha: false, desynchronized: true });
      if (!ctx) throw new Error('Canvas renderer unavailable');
      return {
        draw(frame) {
          const width = Math.max(1, Number(frame.displayWidth || frame.codedWidth || state.width));
          const height = Math.max(
            1,
            Number(frame.displayHeight || frame.codedHeight || state.height),
          );
          if (target.width !== width || target.height !== height) {
            target.width = width;
            target.height = height;
            state.width = width;
            state.height = height;
            updateUi();
          }
          ctx.drawImage(frame, 0, 0, target.width, target.height);
        },
        close() {},
      };
    }

    const vertex = compileShader(
      gl,
      gl.VERTEX_SHADER,
      '#version 300 es\n' +
        'in vec2 a_position; in vec2 a_texcoord; out vec2 v_texcoord;\n' +
        'void main(){ gl_Position=vec4(a_position,0.0,1.0); v_texcoord=a_texcoord; }',
    );
    const fragment = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      '#version 300 es\n' +
        'precision mediump float; uniform sampler2D u_texture; in vec2 v_texcoord; out vec4 out_color;\n' +
        'void main(){ out_color=texture(u_texture,v_texcoord); }',
    );
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'WebGL program link failed');
    }
    gl.useProgram(program);
    const vertices = new Float32Array([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
    const pos = gl.getAttribLocation(program, 'a_position');
    const uv = gl.getAttribLocation(program, 'a_texcoord');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(uv);
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const sampler = gl.getUniformLocation(program, 'u_texture');
    gl.uniform1i(sampler, 0);

    return {
      draw(frame) {
        const width = Math.max(1, Number(frame.displayWidth || frame.codedWidth || state.width));
        const height = Math.max(
          1,
          Number(frame.displayHeight || frame.codedHeight || state.height),
        );
        if (target.width !== width || target.height !== height) {
          target.width = width;
          target.height = height;
          state.width = width;
          state.height = height;
          updateUi();
        }
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.flush();
      },
      close() {
        try {
          gl.deleteTexture(texture);
        } catch {}
        try {
          gl.deleteBuffer(buffer);
        } catch {}
        try {
          gl.deleteProgram(program);
        } catch {}
      },
    };
  }

  function createDecoder(generation, width, height) {
    if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') {
      throw new Error('WebCodecs AV1 unavailable');
    }
    let lastPts90k = null;
    let timestampTicks = 0;
    let first = true;
    const renderer = createRenderer(canvas);
    state.renderer = renderer;
    const decoder = new VideoDecoder({
      output(frame) {
        if (generation !== state.generation) {
          try {
            frame.close();
          } catch {}
          return;
        }
        try {
          renderer.draw(frame);
          if (first) {
            first = false;
            setPlaceholder('', false);
            setStatus('online', state.selected === 'native' ? 'Native Live' : 'Browser Live');
          }
        } catch (error) {
          fail(error, generation);
        } finally {
          try {
            frame.close();
          } catch {}
        }
      },
      error(error) {
        fail(error, generation);
      },
    });
    const config = {
      codec: AV1_CODEC,
      codedWidth: width,
      codedHeight: height,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    };
    decoder.configure(config);
    state.decoder = decoder;
    return {
      submit(flags, pts90k, payload) {
        if (generation !== state.generation) return;
        if (lastPts90k == null) timestampTicks = 0;
        else {
          let ticks = (pts90k - lastPts90k) >>> 0;
          if (!ticks || ticks > 0x7fffffff) ticks = 1;
          timestampTicks += ticks;
        }
        lastPts90k = pts90k;
        const timestampUs = Math.round((timestampTicks * 1000000) / 90000);
        decoder.decode(
          new EncodedVideoChunk({
            type: flags & 1 ? 'key' : 'delta',
            timestamp: timestampUs,
            data: payload,
          }),
        );
      },
    };
  }

  function createAssembler(submit, requestKeyframe = () => false, initialWaitForKeyframe = false) {
    let assembly = null;
    let lastCompletedFrameId = null;
    let waitingForKeyframe = initialWaitForKeyframe;
    return (data) => {
      if (!(data instanceof ArrayBuffer)) return;
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
      if (!chunkCount || chunkIndex >= chunkCount || !totalLen || totalLen > 16 * 1024 * 1024)
        return;
      if (!assembly || assembly.frameId !== frameId) {
        if (assembly && assembly.received !== assembly.chunkCount) {
          waitingForKeyframe = true;
          requestKeyframe('incomplete-frame');
        }
        assembly = {
          frameId,
          flags: packet[4],
          pts90k: view.getUint32(12),
          chunkCount,
          totalLen,
          chunks: new Array(chunkCount),
          received: 0,
          bytes: 0,
        };
      }
      if (
        assembly.chunkCount !== chunkCount ||
        assembly.totalLen !== totalLen ||
        assembly.chunks[chunkIndex]
      )
        return;
      const chunk = packet.subarray(24);
      assembly.chunks[chunkIndex] = chunk.slice();
      assembly.received += 1;
      assembly.bytes += chunk.byteLength;
      if (assembly.received !== assembly.chunkCount) return;
      if (assembly.bytes !== assembly.totalLen) {
        assembly = null;
        waitingForKeyframe = true;
        requestKeyframe('frame-size-mismatch');
        return;
      }
      const payload = new Uint8Array(assembly.totalLen);
      let offset = 0;
      for (const part of assembly.chunks) {
        if (!part) {
          assembly = null;
          waitingForKeyframe = true;
          requestKeyframe('missing-frame-chunk');
          return;
        }
        payload.set(part, offset);
        offset += part.byteLength;
      }
      const completed = assembly;
      assembly = null;
      const isKeyframe = (completed.flags & 1) !== 0;
      if (lastCompletedFrameId !== null) {
        const step = (completed.frameId - lastCompletedFrameId) >>> 0;
        if (step > 1 && step < 0x80000000) {
          waitingForKeyframe = true;
          requestKeyframe('frame-gap');
        }
      }
      lastCompletedFrameId = completed.frameId;
      if (waitingForKeyframe && !isKeyframe) {
        requestKeyframe('await-keyframe');
        return;
      }
      if (isKeyframe) waitingForKeyframe = false;
      submit(completed.flags, completed.pts90k, payload);
    };
  }

  async function connectBrowserVideo(generation) {
    state.width = 1920;
    state.height = 1080;
    updateUi();
    const pipeline = createDecoder(generation, state.width, state.height);
    const pc = new RTCPeerConnection({ iceServers: [] });
    state.pc = pc;
    const dc = pc.createDataChannel('video', { ordered: true });
    dc.binaryType = 'arraybuffer';
    state.videoDc = dc;
    const assemble = createAssembler((flags, pts90k, payload) =>
      pipeline.submit(flags, pts90k, payload),
    );
    dc.addEventListener('message', (event) => {
      if (generation === state.generation) assemble(event.data);
    });
    pc.addEventListener('connectionstatechange', () => {
      if (generation !== state.generation) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        fail(new Error('Browser RTC ' + pc.connectionState), generation);
      }
    });
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser video DataChannel timeout')), 7000);
      dc.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      dc.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('Browser video DataChannel failed'));
        },
        { once: true },
      );
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce(pc);
    if (generation !== state.generation) return;
    const response = await authFetch('/mcpmonitor/widget/browser/video/dc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sdp: (pc.localDescription && pc.localDescription.sdp) || '' }),
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok || !answer.sdp)
      throw new Error(answer.error || 'Browser video HTTP ' + response.status);
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    await opened;
  }

  async function connectNative(generation) {
    const healthResponse = await authFetch('/mcpmonitor/widget/native/health');
    const health = await healthResponse.json().catch(() => ({}));
    if (!healthResponse.ok)
      throw new Error(health.error || 'Native health HTTP ' + healthResponse.status);
    if (generation !== state.generation) return;
    state.width = Math.max(1, Number(health.width || 1920));
    state.height = Math.max(1, Number(health.height || 1080));
    updateUi();
    const pipeline = createDecoder(generation, state.width, state.height);
    const pc = new RTCPeerConnection({ iceServers: [] });
    state.pc = pc;
    const videoDc = pc.createDataChannel('video', {
      ordered: true,
      maxRetransmits: 0,
      negotiated: true,
      id: 0,
    });
    const inputDc = pc.createDataChannel('input', { ordered: true, negotiated: true, id: 1 });
    videoDc.binaryType = 'arraybuffer';
    state.videoDc = videoDc;
    state.inputDc = inputDc;
    inputDc.addEventListener('message', handleNativeCursorMessage);
    let lastKeyframeRequestAt = -Infinity;
    const requestKeyframe = (reason) => {
      const now = performance.now();
      if (now - lastKeyframeRequestAt < 250) return false;
      lastKeyframeRequestAt = now;
      const sent = nativeControlSend({ t: 'snapshot' });
      if (!sent) console.debug('Native widget keyframe request deferred', reason);
      return sent;
    };
    const assemble = createAssembler(
      (flags, pts90k, payload) => pipeline.submit(flags, pts90k, payload),
      requestKeyframe,
      true,
    );
    videoDc.addEventListener('message', (event) => {
      if (generation === state.generation) assemble(event.data);
    });
    videoDc.addEventListener(
      'close',
      () => {
        if (generation === state.generation)
          fail(new Error('Native video DataChannel closed'), generation);
      },
      { once: true },
    );
    inputDc.addEventListener(
      'close',
      () => {
        if (generation === state.generation)
          fail(new Error('Native input DataChannel closed'), generation);
      },
      { once: true },
    );
    let wasDisconnected = false;
    pc.addEventListener('connectionstatechange', () => {
      if (generation !== state.generation) return;
      if (pc.connectionState === 'disconnected') {
        wasDisconnected = true;
        if (!state.disconnectTimer)
          state.disconnectTimer = setTimeout(() => {
            state.disconnectTimer = 0;
            if (generation === state.generation && pc.connectionState === 'disconnected') {
              fail(new Error('Native RTC disconnected'), generation);
            }
          }, 14000);
      } else if (pc.connectionState === 'connected') {
        clearTimeout(state.disconnectTimer);
        state.disconnectTimer = 0;
        if (wasDisconnected) {
          wasDisconnected = false;
          requestKeyframe('transport-reconnected');
        }
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        clearTimeout(state.disconnectTimer);
        state.disconnectTimer = 0;
        fail(new Error('Native RTC ' + pc.connectionState), generation);
      }
    });
    const open = (dc, label) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(label + ' DataChannel timeout')), 7000);
        dc.addEventListener(
          'open',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        dc.addEventListener(
          'error',
          () => {
            clearTimeout(timer);
            reject(new Error(label + ' DataChannel failed'));
          },
          { once: true },
        );
      });
    const videoOpen = open(videoDc, 'Native video');
    const inputOpen = open(inputDc, 'Native input');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce(pc);
    if (generation !== state.generation) return;
    const response = await authFetch('/mcpmonitor/widget/native/dc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sdp: (pc.localDescription && pc.localDescription.sdp) || '' }),
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok || !answer.sdp)
      throw new Error(answer.error || 'Native DC HTTP ' + response.status);
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    await Promise.all([videoOpen, inputOpen]);
  }

  function browserWsUrl() {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return scheme + '//' + location.host + '/mcpmonitor/widget/browser/ws';
  }

  function openBrowserControl() {
    if (state.selected !== 'browser' || !isInteractive() || state.browserWs) return;
    const ws = new WebSocket(browserWsUrl(), [
      'mcpmonitor-widget-v1',
      'mcpmonitor-widget-token.' + token,
    ]);
    state.browserWs = ws;
    ws.addEventListener('open', () => {
      if (state.browserWs !== ws) return;
      try {
        ws.send(JSON.stringify({ type: 'state' }));
      } catch {}
    });
    ws.addEventListener('close', () => {
      if (state.browserWs === ws) state.browserWs = null;
    });
    ws.addEventListener('error', () => {});
  }

  function closeBrowserControl() {
    const ws = state.browserWs;
    state.browserWs = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close(1000, 'viewer input inactive');
      } catch {}
    }
  }

  function browserSend(event) {
    const ws = state.browserWs;
    if (!isInteractive() || state.selected !== 'browser' || !ws || ws.readyState !== WebSocket.OPEN)
      return false;
    try {
      ws.send(JSON.stringify({ type: 'input', event }));
      return true;
    } catch {
      return false;
    }
  }

  function nativeControlSend(message) {
    const dc = state.inputDc;
    if (state.selected !== 'native' || !dc || dc.readyState !== 'open') return false;
    try {
      dc.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function nativeSend(message) {
    if (!isInteractive()) return false;
    return nativeControlSend(message);
  }

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

  async function lockNativeEscapeIfEligible(epoch) {
    if (
      epoch !== nativeCaptureEnhancementEpoch ||
      document.pointerLockElement !== stage ||
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
    if (!nativeBrowserFullscreenActive() || typeof document.documentElement.requestFullscreen !== 'function')
      return;
    const epoch = ++nativeCaptureEnhancementEpoch;
    if (typeof navigator.keyboard?.lock === 'function') {
      try {
        const keyboardRequest = navigator.keyboard.lock(['Escape']);
        Promise.resolve(keyboardRequest)
          .then(() => {
            if (epoch === nativeCaptureEnhancementEpoch) nativeCaptureKeyboardLocked = true;
            else navigator.keyboard?.unlock?.();
          })
          .catch((error) => console.warn('Native keyboard lock unavailable', error));
      } catch (error) {
        console.warn('Native keyboard lock unavailable', error);
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
          void lockNativeEscapeIfEligible(epoch);
        })
        .catch((error) => console.warn('Native fullscreen keyboard-lock enhancement unavailable', error));
    } catch (error) {
      console.warn('Native fullscreen keyboard-lock enhancement unavailable', error);
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
    releaseInput();
    if (document.pointerLockElement === stage) document.exitPointerLock?.();
    clearNativeEscapeCapture();
  }

  function enterNativeMouseCapture({ enhanceEscape = false } = {}) {
    if (!isInteractive() || state.selected !== 'native') return;
    try {
      stage.focus({ preventScroll: true });
    } catch {
      stage.focus();
    }
    try {
      const pointerRequest = stage.requestPointerLock?.();
      pointerRequest?.catch?.((error) => console.warn('Native pointer lock failed', error));
    } catch (error) {
      console.warn('Native pointer lock failed', error);
    }
    if (enhanceEscape) maybeEnableNativeEscapeCapture();
  }

  function toggleNativeMouseCapture({ enhanceEscape = false } = {}) {
    if (document.pointerLockElement === stage) leaveNativeMouseCapture();
    else enterNativeMouseCapture({ enhanceEscape });
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
  function renderNativeCursor() {
    const overlay = $('native-cursor-overlay');
    if (!overlay) return;
    if (state.selected !== 'native' || !isInteractive()) {
      overlay.classList.remove('visible');
      stage.style.cursor = '';
      return;
    }
    const cursor = state.cursor || {};
    const visible = cursor.visible === true;
    const locked = document.pointerLockElement === stage;
    stage.style.cursor = visible && !locked ? nativeCursorCss(cursor.shape) : 'none';
    overlay.classList.toggle('visible', visible && locked);
    if (!visible || !locked) return;
    const rect = contentRect();
    const stageRect = stage.getBoundingClientRect();
    const x =
      rect.left -
      stageRect.left +
      (Math.max(0, Math.min(rect.vw - 1, Number(cursor.x || 0))) * rect.width) / rect.vw;
    const y =
      rect.top -
      stageRect.top +
      (Math.max(0, Math.min(rect.vh - 1, Number(cursor.y || 0))) * rect.height) / rect.vh;
    overlay.style.left = `${x}px`;
    overlay.style.top = `${y}px`;
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
    state.cursor = {
      t: 'cursor',
      x: Number(message.x || 0),
      y: Number(message.y || 0),
      visible: message.visible === true,
      shape: String(message.shape || 'default'),
      hotspotX: Number(message.hotspotX || 0),
      hotspotY: Number(message.hotspotY || 0),
    };
    renderNativeCursor();
  }

  function releaseInput() {
    if (state.selected === 'native') {
      for (const code of state.pressedNativeKeys) nativeSend({ t: 'k', code, down: false });
      state.pressedNativeKeys.clear();
      nativeSend({ t: 'reset' });
    }
    closeBrowserControl();
    browserInput.value = '';
    browserInput.classList.remove('ime');
    browserInput.blur();
  }

  function disconnect() {
    clearTimeout(state.reconnectTimer);
    clearTimeout(state.disconnectTimer);
    state.reconnectTimer = 0;
    state.disconnectTimer = 0;
    releaseInput();
    state.generation += 1;
    if (state.moveRaf) cancelAnimationFrame(state.moveRaf);
    if (state.wheelRaf) cancelAnimationFrame(state.wheelRaf);
    state.moveRaf = 0;
    state.wheelRaf = 0;
    state.pendingMove = null;
    state.pendingWheel = null;
    try {
      state.decoder && state.decoder.close();
    } catch {}
    try {
      state.renderer && state.renderer.close();
    } catch {}
    try {
      state.videoDc && state.videoDc.close();
    } catch {}
    try {
      state.inputDc && state.inputDc.close();
    } catch {}
    try {
      state.pc && state.pc.close();
    } catch {}
    state.decoder = null;
    state.renderer = null;
    state.videoDc = null;
    state.inputDc = null;
    state.pc = null;
    state.assembler = null;
    state.pointerId = null;
    state.cursor = {
      t: 'cursor',
      x: 0,
      y: 0,
      visible: false,
      shape: 'default',
      hotspotX: 0,
      hotspotY: 0,
    };
    renderNativeCursor();
  }

  function suspend() {
    if (!Number.isFinite(state.suspendedAt)) state.suspendedAt = Date.now();
    releaseInput();
  }

  function resume({ forceFresh = false, immediate = false } = {}) {
    const now = Date.now();
    const hiddenFor = Number.isFinite(state.suspendedAt) ? Math.max(0, now - state.suspendedAt) : 0;
    const heartbeatGap = Number.isFinite(state.lifecycleHeartbeatAt)
      ? Math.max(0, now - state.lifecycleHeartbeatAt)
      : 0;
    state.suspendedAt = null;
    state.lifecycleHeartbeatAt = now;
    state.resumeForceFresh =
      state.resumeForceFresh ||
      forceFresh ||
      hiddenFor >= PAGE_SLEEP_RECOVERY_GAP_MS ||
      heartbeatGap >= PAGE_SLEEP_RECOVERY_GAP_MS;
    clearTimeout(state.resumeTimer);
    state.resumeTimer = setTimeout(
      () => {
        state.resumeTimer = 0;
        const refreshTransport = state.resumeForceFresh;
        state.resumeForceFresh = false;
        if (refreshTransport) connectSelected();
        else if (isInteractive() && state.selected === 'browser') openBrowserControl();
      },
      immediate ? 0 : 100,
    );
  }

  function fail(error, generation) {
    if (generation !== state.generation) return;
    setStatus('error', '连接中断');
    setPlaceholder('正在重新连接 ' + (state.selected === 'native' ? 'Native' : 'Browser'), true);
    disconnect();
    state.reconnectTimer = setTimeout(connectSelected, 900);
  }

  async function connectSelected() {
    disconnect();
    const generation = state.generation;
    const label = state.selected === 'native' ? 'Native' : 'Browser';
    setStatus('', '连接中');
    setPlaceholder('正在连接 ' + label, true);
    try {
      if (!token) throw new Error('viewer capability missing');
      if (typeof RTCPeerConnection !== 'function') throw new Error('WebRTC unavailable');
      if (state.selected === 'native') await connectNative(generation);
      else await connectBrowserVideo(generation);
      if (generation !== state.generation) return;
      if (state.selected === 'browser' && isInteractive()) openBrowserControl();
    } catch (error) {
      fail(error, generation);
    }
  }

  function setSurface(surface) {
    surface = surface === 'native' ? 'native' : 'browser';
    if (surface === state.selected) return;
    state.selected = surface;
    updateUi();
    renderNativeCursor();
    connectSelected();
  }

  function contentRect() {
    const rect = stage.getBoundingClientRect();
    const vw = state.width || 1920;
    const vh = state.height || 1080;
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

  function pointForEvent(event) {
    const rect = contentRect();
    if (!rect.width || !rect.height) return null;
    if (
      event.clientX < rect.left ||
      event.clientY < rect.top ||
      event.clientX >= rect.left + rect.width ||
      event.clientY >= rect.top + rect.height
    )
      return null;
    const nx = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    return {
      nx,
      ny,
      x: Math.max(0, Math.min(rect.vw - 1, nx * rect.vw)),
      y: Math.max(0, Math.min(rect.vh - 1, ny * rect.vh)),
    };
  }

  function queueMove(message) {
    state.pendingMove = message;
    if (state.moveRaf) return;
    state.moveRaf = requestAnimationFrame(() => {
      state.moveRaf = 0;
      const next = state.pendingMove;
      state.pendingMove = null;
      if (!next) return;
      if (state.selected === 'native') nativeSend(next);
      else browserSend(Object.assign({ kind: 'mouse', native: true }, next));
    });
  }

  function queueWheel(point, dx, dy) {
    if (!state.pendingWheel) state.pendingWheel = { point, dx: 0, dy: 0 };
    state.pendingWheel.point = point || state.pendingWheel.point;
    state.pendingWheel.dx += dx;
    state.pendingWheel.dy += dy;
    if (state.wheelRaf) return;
    state.wheelRaf = requestAnimationFrame(() => {
      state.wheelRaf = 0;
      const next = state.pendingWheel;
      state.pendingWheel = null;
      if (!next) return;
      if (state.selected === 'native') {
        nativeSend({
          t: 'w',
          dx: Math.max(-60, Math.min(60, next.dx / 8)),
          dy: Math.max(-60, Math.min(60, next.dy / 8)),
        });
      } else if (next.point) {
        browserSend({
          kind: 'mouse',
          native: true,
          action: 'wheel',
          x: next.point.nx,
          y: next.point.ny,
          dx: Math.max(-960, Math.min(960, next.dx)),
          dy: Math.max(-960, Math.min(960, next.dy)),
        });
      }
    });
  }

  function browserText(text) {
    text = String(text || '');
    if (!text) return;
    browserSend({ kind: 'key', native: true, action: 'type', text, route: 'native' });
  }

  function browserStroke(event) {
    const key = String(event.key || '');
    if (!key || key === 'Unidentified' || ['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return;
    const modifiers = [];
    if (event.ctrlKey) modifiers.push('Control');
    if (event.altKey) modifiers.push('Alt');
    if (event.metaKey) modifiers.push('Meta');
    if (event.shiftKey) modifiers.push('Shift');
    for (const modifier of modifiers) {
      browserSend({ kind: 'key', native: true, action: 'down', key: modifier });
    }
    browserSend({ kind: 'key', native: true, action: 'down', key });
    browserSend({ kind: 'key', native: true, action: 'up', key });
    for (let i = modifiers.length - 1; i >= 0; i -= 1) {
      browserSend({ kind: 'key', native: true, action: 'up', key: modifiers[i] });
    }
  }

  tabBrowser.addEventListener('click', () => setSurface('browser'));
  tabNative.addEventListener('click', () => setSurface('native'));
  expand.addEventListener('click', () => requestDisplay(isInteractive() ? 'pip' : 'fullscreen'));
  relative.addEventListener('click', () => {
    if (!isInteractive() || state.selected !== 'native') return;
    toggleNativeMouseCapture();
  });

  stage.addEventListener('contextmenu', (event) => event.preventDefault());
  stage.addEventListener('auxclick', (event) => event.preventDefault());
  for (const type of ['mousedown', 'mouseup', 'contextmenu', 'auxclick']) {
    document.addEventListener(
      type,
      (event) => {
        if (
          state.selected !== 'native' ||
          (document.pointerLockElement !== stage &&
            event.target !== stage &&
            !stage.contains(event.target))
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
  stage.addEventListener('pointerdown', (event) => {
    if (!isInteractive()) {
      event.preventDefault();
      requestDisplay('fullscreen');
      return;
    }
    event.preventDefault();
    if (state.selected === 'browser') {
      openBrowserControl();
      try {
        browserInput.focus({ preventScroll: true });
      } catch {
        browserInput.focus();
      }
      const point = pointForEvent(event);
      if (point) {
        browserSend({ kind: 'mouse', native: true, action: 'move', x: point.nx, y: point.ny });
        browserSend({
          kind: 'mouse',
          native: true,
          action: 'down',
          button: ['left', 'middle', 'right'][event.button] || 'left',
          x: point.nx,
          y: point.ny,
        });
      }
    } else {
      try {
        stage.focus({ preventScroll: true });
      } catch {
        stage.focus();
      }
      if (document.pointerLockElement !== stage) {
        const point = pointForEvent(event);
        if (point) nativeSend({ t: 'm', x: point.x, y: point.y });
      }
      nativeSend({ t: 'b', button: event.button, down: true });
    }
    state.pointerId = event.pointerId;
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {}
  });

  stage.addEventListener('pointerup', (event) => {
    if (!isInteractive()) return;
    event.preventDefault();
    if (state.selected === 'browser') {
      const point = pointForEvent(event);
      if (point)
        browserSend({
          kind: 'mouse',
          native: true,
          action: 'up',
          button: ['left', 'middle', 'right'][event.button] || 'left',
          x: point.nx,
          y: point.ny,
        });
    } else {
      nativeSend({ t: 'b', button: event.button, down: false });
    }
    state.pointerId = null;
    try {
      stage.releasePointerCapture(event.pointerId);
    } catch {}
  });

  stage.addEventListener('pointercancel', () => {
    state.pointerId = null;
    if (state.selected === 'native') nativeSend({ t: 'reset' });
    else closeBrowserControl();
  });

  stage.addEventListener('pointermove', (event) => {
    if (!isInteractive()) return;
    if (state.selected === 'native' && document.pointerLockElement === stage) {
      queueMove({ t: 'mr', dx: event.movementX || 0, dy: event.movementY || 0 });
      return;
    }
    const point = pointForEvent(event);
    if (!point) return;
    if (state.selected === 'native') queueMove({ t: 'm', x: point.x, y: point.y });
    else queueMove({ action: 'move', x: point.nx, y: point.ny });
  });

  stage.addEventListener(
    'wheel',
    (event) => {
      if (!isInteractive()) {
        event.preventDefault();
        requestDisplay('fullscreen');
        return;
      }
      event.preventDefault();
      queueWheel(pointForEvent(event), Number(event.deltaX || 0), Number(event.deltaY || 0));
    },
    { passive: false },
  );

  let composing = false;
  browserInput.addEventListener('compositionstart', () => {
    composing = true;
    browserInput.classList.add('ime');
  });
  browserInput.addEventListener('compositionend', (event) => {
    composing = false;
    const text = String(event.data || browserInput.value || '');
    browserInput.value = '';
    browserInput.classList.remove('ime');
    browserText(text);
  });
  browserInput.addEventListener('beforeinput', (event) => {
    if (composing || event.isComposing) return;
    const type = String(event.inputType || '');
    const data = event.data == null ? '' : String(event.data);
    if (type === 'insertText' && data) {
      if (event.cancelable) event.preventDefault();
      browserInput.value = '';
      browserText(data);
    }
  });
  browserInput.addEventListener('input', (event) => {
    if (composing) return;
    const type = String(event.inputType || '');
    if (type === 'insertText' && event.data) {
      browserText(String(event.data));
      browserInput.value = '';
    }
  });
  browserInput.addEventListener('keydown', (event) => {
    if (!isInteractive() || state.selected !== 'browser') return;
    if (composing || event.isComposing) return;
    const key = String(event.key || '');
    const printable = key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (printable) return;
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return;
    event.preventDefault();
    browserStroke(event);
  });
  browserInput.addEventListener('blur', () => {
    browserInput.value = '';
  });

  stage.addEventListener('keydown', (event) => {
    if (!isInteractive() || state.selected !== 'native') return;
    event.preventDefault();
    if (event.repeat) return;
    state.pressedNativeKeys.add(event.code);
    nativeSend({ t: 'k', code: event.code, down: true });
  });
  stage.addEventListener('keyup', (event) => {
    if (!isInteractive() || state.selected !== 'native') return;
    event.preventDefault();
    state.pressedNativeKeys.delete(event.code);
    nativeSend({ t: 'k', code: event.code, down: false });
  });

  document.addEventListener(
    'keydown',
    (event) => {
      if (!nativeCaptureShortcut(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      suppressNativeCaptureShortcutKeyUp = true;
      toggleNativeMouseCapture({ enhanceEscape: true });
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

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === stage;
    relative.setAttribute('aria-pressed', String(locked));
    if (!locked) clearNativeEscapeCapture();
    else if (nativeCaptureFullscreenOwned)
      void lockNativeEscapeIfEligible(nativeCaptureEnhancementEpoch);
    renderNativeCursor();
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
  window.addEventListener('resize', renderNativeCursor);

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.type !== 'cua-host-state') return;
    const oldInteractive = isInteractive();
    state.mode =
      message.displayMode === 'fullscreen' ? 'fullscreen' : message.displayMode || 'inline';
    updateUi();
    if (!oldInteractive && isInteractive()) {
      if (state.selected === 'browser') openBrowserControl();
      else {
        try {
          stage.focus({ preventScroll: true });
        } catch {
          stage.focus();
        }
      }
    } else if (oldInteractive && !isInteractive()) {
      releaseInput();
    }
  });

  window.addEventListener('blur', releaseInput);
  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', (event) =>
    resume({ forceFresh: event.persisted === true, immediate: true }),
  );
  window.addEventListener('focus', () => resume());
  window.addEventListener('online', () => resume({ forceFresh: true, immediate: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspend();
    else resume({ immediate: true });
  });

  setInterval(() => {
    const now = Date.now();
    const gap = Math.max(0, now - state.lifecycleHeartbeatAt);
    state.lifecycleHeartbeatAt = now;
    if (!document.hidden && gap >= PAGE_SLEEP_RECOVERY_GAP_MS) {
      resume({ forceFresh: true, immediate: true });
    }
  }, 1000);

  updateUi();
  connectSelected();
})();
