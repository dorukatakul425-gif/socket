const { createServer } = require('http');
const { Server }       = require('socket.io');

const PORT = process.env.PORT || 3000;

const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK\n');
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingInterval: 20000,
  pingTimeout:  60000,
  maxHttpBufferSize: 1e6,
  allowEIO3: true,
});

// ── State ──
const rooms       = {};
const musicState  = {};
const bottleState = {};
const chatHistory = {};
const turnState   = {};
const socketRoom  = {};

// ── Helpers ──
function getRoom(mid) {
  if (!rooms[mid]) rooms[mid] = {};
  return rooms[mid];
}
function roomPlayers(mid) {
  return Object.values(rooms[mid] || {});
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function masaCounts() {
  const c = {};
  for (const mid of Object.keys(rooms)) {
    const pl = roomPlayers(mid);
    if (!pl.length) continue;
    const isF = g => ['f','female','qiz','qadin','kadin','k'].includes((g||'').toLowerCase().trim());
    c[mid] = { total: pl.length, f: pl.filter(p => isF(p.gender)).length, m: pl.filter(p => !isF(p.gender)).length };
  }
  return c;
}
function broadcastCounts() {
  io.emit('masa_counts', { counts: masaCounts() });
}

// ── Turn ──
function getTurn(mid) {
  if (!turnState[mid]) {
    turnState[mid] = { spinQueue: [], targetQueue: [], current: null, timer: null, pending: null };
  }
  return turnState[mid];
}

function nextTurn(mid) {
  const ts = getTurn(mid);
  const pl = roomPlayers(mid);
  if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }
  if (pl.length < 2) { ts.current = null; return; }

  const ids    = pl.map(p => String(p.db_id));
  const inRoom = new Set(ids);

  ts.spinQueue = ts.spinQueue.filter(id => inRoom.has(id));
  if (!ts.spinQueue.length) ts.spinQueue = shuffle(ids);
  const spinnerId = ts.spinQueue.shift();
  ts.current = spinnerId;

  const others = ids.filter(id => id !== spinnerId);
  ts.targetQueue = ts.targetQueue.filter(id => others.includes(id));
  if (!ts.targetQueue.length) ts.targetQueue = shuffle(others);
  const targetId = ts.targetQueue.shift();

  const spinnerP = (rooms[mid] || {})[spinnerId] || {};
  const targetP  = (rooms[mid] || {})[targetId]  || {};

  io.to(mid).emit('your_turn', {
    userId:        parseInt(spinnerId),
    targetId:      'pu' + targetId,
    masaId:        mid,
    spinnerName:   spinnerP.name   || '',
    spinnerAvatar: spinnerP.avatar || null,
    targetName:    targetP.name    || '',
    targetAvatar:  targetP.avatar  || null,
  });

  ts.timer = setTimeout(() => {
    if (getTurn(mid).current !== spinnerId) return;
    io.to(mid).emit('auto_spin', { userId: parseInt(spinnerId), masaId: mid });
    setTimeout(() => {
      const ts2 = getTurn(mid);
      if (ts2.current === spinnerId) { ts2.current = null; nextTurn(mid); }
    }, 5000);
  }, 12000);
}

function startIfReady(mid) {
  const ts = getTurn(mid);
  if (!ts.current && roomPlayers(mid).length >= 2) {
    setTimeout(() => nextTurn(mid), 800);
  }
}

// ── Connections ──
io.on('connection', (socket) => {

  socket.on('join', (data) => {
    if (!data.userId || !data.masaId) return;
    const uid = String(data.userId);
    const mid = String(data.masaId);

    const existingPlayer = (rooms[mid] || {})[uid];
    if (existingPlayer && existingPlayer.socketId !== socket.id) {
      const ts = getTurn(mid);
      if (ts.current === uid && ts.timer) {
        clearTimeout(ts.timer); ts.timer = null;
        setTimeout(() => {
          const ts2 = getTurn(mid);
          if (ts2.current === uid) {
            io.to(mid).emit('your_turn', { userId: parseInt(uid), masaId: mid });
            ts2.timer = setTimeout(() => {
              if (getTurn(mid).current !== uid) return;
              io.to(mid).emit('auto_spin', { userId: parseInt(uid), masaId: mid });
              setTimeout(() => {
                const ts3 = getTurn(mid);
                if (ts3.current === uid) { ts3.current = null; nextTurn(mid); }
              }, 5000);
            }, 12000);
          }
        }, 1000);
      }
    }

    socketRoom[socket.id] = { uid, mid };
    socket.join(mid);

    getRoom(mid)[uid] = {
      db_id:     parseInt(uid),
      name:      data.name      || '',
      avatar:    data.avatar    || null,
      gender:    data.gender    || 'm',
      is_vip:    data.isVip     || 0,
      hearts:    data.hearts    || 0,
      cercveSrc: data.cercveSrc || '',
      socketId:  socket.id,
    };

    if (bottleState[mid]) socket.emit('bottle_change', { src: bottleState[mid] });

    if (musicState[mid]) {
      const ms = musicState[mid];
      socket.emit('music_play', { ...ms, elapsedOnJoin: Math.floor((Date.now() - ms.startedAt) / 1000) });
    }

    const hist = chatHistory[mid];
    if (hist && hist.length) socket.emit('chat_history', { messages: hist });

    const pl = roomPlayers(mid);
    io.to(mid).emit('players', { data: pl });
    socket.to(mid).emit('player_join', {
      userId: parseInt(uid), name: data.name || '', avatar: data.avatar || null,
      gender: data.gender || 'm', isVip: data.isVip || 0, cercveSrc: data.cercveSrc || '',
    });

    io.to(mid).emit('online_sayi', { value: pl.length });
    broadcastCounts();
    startIfReady(mid);
  });

  socket.on('chat', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    socket.to(mid).emit('chat', data);
    if (!chatHistory[mid]) chatHistory[mid] = [];
    const hist  = chatHistory[mid];
    const key   = String(data.userId) + '|' + String(data.text);
    const recent = hist.slice(-5);
    if (!recent.some(m => String(m.userId) + '|' + String(m.text) === key)) {
      hist.push({ userId: data.userId, name: data.name || '', avatar: data.avatar || '',
        text: data.text || '', isVip: data.isVip || 0, gender: data.gender || '', cercveSrc: data.cercveSrc || '' });
      if (hist.length > 60) hist.shift();
    }
  });

  // ── SPIN: server rooms'tan oyuncu bilgisini ekler, HERKESE yayınlar ──
  socket.on('spin', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    const ts  = getTurn(mid);

    // Sıra kontrolü
    const entry = socketRoom[socket.id];
    if (entry && ts.current !== null && ts.current !== String(entry.uid)) return;
    if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }

    // Oyuncu bilgilerini rooms'tan güvenilir şekilde al
    const winnerDbId = parseInt((String(data.winner || '')).replace('pu', '')) || 0;
    const pairDbId   = parseInt((String(data.pair   || '')).replace('pu', '')) || 0;
    const winnerP    = (rooms[mid] || {})[String(winnerDbId)] || {};
    const pairP      = (rooms[mid] || {})[String(pairDbId)]   || {};

    const enriched = {
      ...data,
      // Server'dan gelen bilgi öncelikli — client cache'ten geleni ezeriz
      winnerName:   winnerP.name   || data.winnerName   || '',
      winnerAvatar: winnerP.avatar !== undefined ? winnerP.avatar : (data.winnerAvatar || null),
      pairName:     pairP.name     || data.pairName     || '',
      pairAvatar:   pairP.avatar   !== undefined ? pairP.avatar   : (data.pairAvatar   || null),
    };

    // Odadaki HERKESE gönder — çeviren dahil
    io.to(mid).emit('spin', enriched);
  });

  socket.on('kiss', (data) => {
    if (!data.masaId) return;
    socket.to(String(data.masaId)).emit('kiss', data);
  });

  socket.on('kiss_count_update', (data) => {
    if (!data.masaId) return;
    socket.to(String(data.masaId)).emit('kiss_count_update', data);
  });

  socket.on('next_turn_ready', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    const ts  = getTurn(mid);
    if (ts.timer)   { clearTimeout(ts.timer);   ts.timer   = null; }
    if (ts.pending) { clearTimeout(ts.pending); ts.pending = null; }
    ts.pending = setTimeout(() => {
      ts.pending = null;
      ts.current = null;
      nextTurn(mid);
    }, 500);
  });

  socket.on('gift',           (d) => { if (d.masaId) socket.to(String(d.masaId)).emit('gift', d); });
  socket.on('profile_like',   (d) => { if (d.masaId) socket.to(String(d.masaId)).emit('profile_like', d); });
  socket.on('profile_unlike', (d) => { if (d.masaId) socket.to(String(d.masaId)).emit('profile_unlike', d); });
  socket.on('bildiris',       (d) => { if (d.masaId) io.to(String(d.masaId)).emit('bildiris', d); });
  socket.on('ping',           ()  => socket.emit('pong'));
  socket.on('your_turn',      ()  => {});
  socket.on('auto_spin',      ()  => {});

  socket.on('bottle_change', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    if (data.src) bottleState[mid] = data.src;
    io.to(mid).emit('bottle_change', { src: data.src, userId: data.userId });
  });

  socket.on('cercve_change', (data) => {
    if (!data.masaId) return;
    const uid  = String(data.userId);
    const mid  = String(data.masaId);
    const room = getRoom(mid);
    if (room[uid]) room[uid].cercveSrc = data.src || '';
    socket.to(mid).emit('cercve_change', data);
  });

  socket.on('music_play', (data) => {
    if (!data.masaId) return;
    musicState[String(data.masaId)] = { ...data, startedAt: data.startedAt || Date.now() };
    socket.to(String(data.masaId)).emit('music_play', data);
  });

  socket.on('music_stop', (data) => {
    if (!data.masaId) return;
    delete musicState[String(data.masaId)];
    socket.to(String(data.masaId)).emit('music_stop', data);
  });

  socket.on('disconnect', () => {
    const entry = socketRoom[socket.id];
    delete socketRoom[socket.id];
    if (!entry) return;

    const { uid, mid } = entry;
    const room = getRoom(mid);
    if (room[uid] && room[uid].socketId !== socket.id) return;
    delete room[uid];

    const ts = getTurn(mid);
    if (ts.current === uid) {
      if (ts.timer)   { clearTimeout(ts.timer);   ts.timer   = null; }
      if (ts.pending) { clearTimeout(ts.pending); ts.pending = null; }
      ts.current = null;
      setTimeout(() => nextTurn(mid), 500);
    }

    ts.spinQueue   = ts.spinQueue.filter(id => id !== uid);
    ts.targetQueue = ts.targetQueue.filter(id => id !== uid);

    const pl = roomPlayers(mid);
    socket.to(mid).emit('player_leave', { userId: parseInt(uid) });
    io.to(mid).emit('players',     { data: pl });
    io.to(mid).emit('online_sayi', { value: pl.length });

    if (pl.length === 0) {
      delete rooms[mid]; delete musicState[mid]; delete turnState[mid];
      delete chatHistory[mid];
      // bottleState[mid] SAKLANIR — oda boşalsa bile şişe korunur
    } else if (pl.length === 1) {
      if (ts.timer)   { clearTimeout(ts.timer);   ts.timer   = null; }
      if (ts.pending) { clearTimeout(ts.pending); ts.pending = null; }
      ts.current = null; ts.spinQueue = []; ts.targetQueue = [];
    }

    broadcastCounts();
  });
});

// Memory leak koruması
setInterval(() => {
  for (const mid of Object.keys(rooms)) {
    if (roomPlayers(mid).length === 0) {
      delete rooms[mid]; delete musicState[mid]; delete turnState[mid];
      delete chatHistory[mid];
      // bottleState[mid] korunur
    }
  }
  for (const sid of Object.keys(socketRoom)) {
    if (!io.sockets.sockets.has(sid)) delete socketRoom[sid];
  }
}, 10 * 60 * 1000);

httpServer.listen(PORT, () => {});
