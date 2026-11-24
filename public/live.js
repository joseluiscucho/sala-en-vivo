/* Capa "en vivo": chat real (Socket.IO) + video del presentador (WebRTC).
   Se apoya en las funciones/estado de la página original. */
(() => {
  const WANT_HOST = location.hash === '#presentador';
  const MAX_BITRATE = 1000000; // bits/s por espectador. Baja a 600000 si tu subida es lenta.

  const socket = io();
  let isHost = false;
  let hostPassword = null;
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  fetch('/ice').then((r) => r.json()).then((s) => { iceServers = s; }).catch(() => {});

  // Controles solo para el presentador; el modo demo ya no aplica
  const st = document.createElement('style');
  st.textContent = `
    body:not(.is-host) #btn-share-screen, body:not(.is-host) #btn-start-idle,
    body:not(.is-host) #btn-retry-capture, body:not(.is-host) #btn-switch-source,
    body:not(.is-host) #btn-pause-resume, body:not(.is-host) #btn-stop-share,
    #btn-demo-mode, #btn-demo-idle, #btn-fallback-demo { display: none !important; }`;
  document.head.appendChild(st);

  // Cola por par para procesar señales en orden
  const chains = new Map();
  const enqueue = (id, fn) => {
    chains.set(id, (chains.get(id) || Promise.resolve()).then(fn).catch((e) => console.warn(e)));
  };

  /* ---------------- CHAT ---------------- */
  const fmt = (ts) => new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const toMsg = (m) => ({ ...m, time: fmt(m.ts) });

  loadChatState = function () {
    try {
      const n = localStorage.getItem(STORAGE_KEYS.NICKNAME);
      if (n && n.trim()) state.nickname = n.trim();
    } catch (_) {}
    dom.nicknameInput.value = state.nickname;
  };
  saveMessages = () => {};
  initParticipantsCounter = () => {};
  appendSystemMessage = (t) => { if (isHost) socket.emit('system', t); };
  sendChatMessage = (raw) => {
    const text = (raw || '').trim();
    if (!text) return;
    const nick = (dom.nicknameInput.value || '').trim();
    if (nick && nick !== state.nickname) {
      state.nickname = nick;
      try { localStorage.setItem(STORAGE_KEYS.NICKNAME, nick); } catch (_) {}
    }
    socket.emit('chat', { author: state.nickname || 'Invitado', text });
  };

  socket.on('history', (list) => { state.messages = list.map(toMsg); renderChatMessages(false); });
  socket.on('chat', (m) => {
    state.messages.push(toMsg(m));
    if (state.messages.length > 200) state.messages.shift();
    renderChatMessages(true);
  });
  socket.on('count', (n) => { state.onlineCount = n; dom.onlineCount.textContent = String(n); });

  /* ---------------- TEXTO PARA ESPECTADORES ---------------- */
  const _sync = syncStageUI;
  syncStageUI = () => {
    _sync();
    if (!isHost) {
      dom.sourceMeta.textContent = state.isLive
        ? 'Transmisión en vivo del presentador'
        : 'Esperando a que el presentador inicie la transmisión';
    }
  };

  /* ---------------- PRESENTADOR ---------------- */
  const pcs = new Map();
  const closePc = (id) => { const pc = pcs.get(id); if (pc) { try { pc.close(); } catch (_) {} } pcs.delete(id); };
  const goLive = () => socket.emit('live-start', state.sourceLabel);

  async function makeOffer(id) {
    if (!state.stream) return;
    closePc(id);
    const pc = new RTCPeerConnection({ iceServers });
    pcs.set(id, pc);
    state.stream.getTracks().forEach((t) => pc.addTrack(t, state.stream));
    pc.getSenders().forEach((s) => {
      if (s.track && s.track.kind === 'video') {
        const p = s.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = MAX_BITRATE;
        s.setParameters(p).catch(() => {});
      }
    });
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } }); };
    await pc.setLocalDescription(await pc.createOffer());
    socket.emit('signal', { to: id, data: { sdp: pc.localDescription } });
  }

  const _start = startScreenShare;
  startScreenShare = async (sw) => {
    await _start(sw);
    if (isHost && state.isLive && state.stream && !state.isDemo) goLive();
  };
  const _stop = stopPresentation;
  stopPresentation = (b) => {
    _stop(b);
    if (isHost) { [...pcs.keys()].forEach(closePc); socket.emit('live-stop'); }
  };

  socket.on('viewer-ready', (id) => {
    if (isHost && state.stream && state.isLive && !state.isDemo) enqueue(id, () => makeOffer(id));
  });
  socket.on('viewer-left', closePc);

  /* ---------------- ESPECTADOR ---------------- */
  let vpc = null;
  let viewerMuted = true; // los navegadores exigen empezar en silencio
  const closeV = () => { if (vpc) { try { vpc.close(); } catch (_) {} vpc = null; } };

  const _audio = toggleSourceAudio;
  toggleSourceAudio = () => {
    if (isHost) return _audio();
    viewerMuted = !viewerMuted;
    dom.screenVideo.muted = viewerMuted;
    state.isMuted = viewerMuted;
    updateAudioButtonUI();
    showToast(viewerMuted ? 'Audio silenciado' : 'Audio activado');
  };

  function onTrack(e) {
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (dom.screenVideo.srcObject === stream) return;
    dom.screenVideo.srcObject = stream;
    dom.screenVideo.muted = viewerMuted;
    dom.screenVideo.onloadedmetadata = () => {
      const w = dom.screenVideo.videoWidth, h = dom.screenVideo.videoHeight;
      if (w && h) dom.resolutionBadge.textContent = `Resolución: ${w}×${h}`;
    };
    dom.screenVideo.play().catch(() => {});
    state.isLive = true; state.isDemo = false; state.isPaused = false;
    state.isMuted = viewerMuted;
    syncStageUI();
    updateAudioButtonUI();
    if (viewerMuted) showToast('Conectado. Toca "Audio" para escuchar');
  }

  socket.on('live-status', (s) => {
    if (isHost) return;
    if (s.on) {
      state.sourceLabel = s.label || 'Pantalla compartida';
      socket.emit('viewer-ready');
    } else {
      closeV();
      dom.screenVideo.srcObject = null;
      state.isLive = false; state.sourceLabel = '';
      syncStageUI();
    }
  });

  /* ---------------- SEÑALIZACIÓN ---------------- */
  socket.on('signal', ({ from, data }) => {
    if (isHost) {
      enqueue(from, async () => {
        const pc = pcs.get(from);
        if (!pc) return;
        if (data.sdp) await pc.setRemoteDescription(data.sdp);
        else if (data.candidate) await pc.addIceCandidate(data.candidate);
      });
    } else {
      enqueue('host', async () => {
        if (data.sdp) {
          closeV();
          vpc = new RTCPeerConnection({ iceServers });
          vpc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { to: from, data: { candidate: e.candidate } }); };
          vpc.ontrack = onTrack;
          await vpc.setRemoteDescription(data.sdp);
          await vpc.setLocalDescription(await vpc.createAnswer());
          socket.emit('signal', { to: from, data: { sdp: vpc.localDescription } });
        } else if (data.candidate && vpc) {
          await vpc.addIceCandidate(data.candidate);
        }
      });
    }
  });

  /* ---------------- LOGIN DEL PRESENTADOR ---------------- */
  socket.on('connect', () => {
    if (!WANT_HOST) return;
    if (hostPassword === null) hostPassword = prompt('Contraseña del presentador:') || '';
    socket.emit('host-login', hostPassword, (ok) => {
      if (!ok) { hostPassword = null; showToast('Contraseña incorrecta: entraste como espectador'); return; }
      isHost = true;
      document.body.classList.add('is-host');
      showToast('Modo presentador activo');
      syncStageUI();
      if (state.isLive && state.stream && !state.isDemo) goLive(); // tras reconexión
    });
  });
})();
