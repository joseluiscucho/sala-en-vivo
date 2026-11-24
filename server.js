const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const HOST_PASSWORD = process.env.HOST_PASSWORD || 'cambiame';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// Servidores STUN/TURN (TURN opcional por variables de entorno)
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
if (process.env.TURN_URLS) {
  iceServers.push({
    urls: process.env.TURN_URLS.split(',').map((s) => s.trim()),
    username: process.env.TURN_USERNAME,
    credential: process.env.TURN_CREDENTIAL,
  });
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/ice', (_req, res) => res.json(iceServers));

let hostId = null;
let live = { on: false, label: '' };
const history = [];
const count = () => io.emit('count', io.sockets.sockets.size);
const pushMsg = (m) => { history.push(m); if (history.length > 100) history.shift(); io.emit('chat', m); };
const newId = () => crypto.randomBytes(5).toString('hex');

io.on('connection', (socket) => {
  socket.emit('history', history);
  socket.emit('live-status', live);
  count();
  let lastChat = 0;

  socket.on('host-login', (pw, cb) => {
    const ok = typeof pw === 'string' && crypto.timingSafeEqual(sha(pw), sha(HOST_PASSWORD));
    if (ok) {
      hostId = socket.id;
      live = { on: false, label: '' };
      io.emit('live-status', live);
    }
    if (typeof cb === 'function') cb(ok);
  });

  socket.on('live-start', (label) => {
    if (socket.id !== hostId) return;
    live = { on: true, label: String(label || '').slice(0, 120) };
    io.emit('live-status', live);
  });

  socket.on('live-stop', () => {
    if (socket.id !== hostId) return;
    live = { on: false, label: '' };
    io.emit('live-status', live);
  });

  socket.on('viewer-ready', () => {
    if (hostId && socket.id !== hostId) io.to(hostId).emit('viewer-ready', socket.id);
  });

  // Señalización WebRTC: solo entre presentador y espectadores
  socket.on('signal', ({ to, data } = {}) => {
    if (!to || (socket.id !== hostId && to !== hostId)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('chat', ({ author, text } = {}) => {
    const now = Date.now();
    if (now - lastChat < 400) return;
    lastChat = now;
    text = String(text || '').trim().slice(0, 500);
    if (!text) return;
    pushMsg({
      id: newId(),
      author: String(author || 'Invitado').trim().slice(0, 30) || 'Invitado',
      role: socket.id === hostId ? 'Anfitrión' : '',
      text, system: false, ts: now,
    });
  });

  socket.on('system', (text) => {
    if (socket.id !== hostId) return;
    pushMsg({ id: newId(), author: 'Sistema', role: '', text: String(text).slice(0, 300), system: true, ts: Date.now() });
  });

  socket.on('disconnect', () => {
    if (socket.id === hostId) {
      hostId = null;
      live = { on: false, label: '' };
      io.emit('live-status', live);
    } else if (hostId) {
      io.to(hostId).emit('viewer-left', socket.id);
    }
    count();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Sala en vivo escuchando en puerto ' + PORT));
