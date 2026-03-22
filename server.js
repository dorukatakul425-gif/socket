const { createServer } = require('http');
const { Server }       = require('socket.io');
const fs               = require('fs');
const path             = require('path');

const PORT = process.env.PORT || 3000;

// socket.io client JS-ni öz serverimizdən ver — CDN gecikmə yox
const SOCKET_IO_CLIENT_PATH = path.join(
  require.resolve('socket.io'),
  '../../client-dist/socket.io.min.js'
);

const httpServer = createServer((req, res) => {
  if (req.url === '/socket.io.min.js') {
    try {
      const js = fs.readFileSync(SOCKET_IO_CLIENT_PATH);
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(js);
    } catch(e) {}
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK\n');
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket'],
  pingInterval: 25000,
  pingTimeout:  20000,
  maxHttpBufferSize: 1e6,
  allowEIO3: true,
  connectTimeout: 8000,
});

// ── State ──
const rooms            = {};  // mid -> { uid -> playerObj }
const musicState       = {};  // mid -> musicData
const bottleState      = {};  // mid -> bottleSrc
const chatHistory      = {};  // mid -> [msgObj]
const turnState        = {};  // mid -> turnObj
const socketRoom       = {};  // socketId -> { uid, mid }
const disconnectTimers = {};  // legacy — artıq room.__graceTimers istifadə edilir

// ── Helpers ──
function getRoom(mid) {
  if (!rooms[mid]) rooms[mid] = {};
  return rooms[mid];
}
function roomPlayers(mid) {
  return Object.values(rooms[mid] || {}).filter(p => p && p.db_id);
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Gender yoxlama ──
const isF = g => ['f','female','qiz','qadin','kadin','k'].includes((g||'').toLowerCase().trim());

// ── Masa sayısı — players array ilə ──
function masaCounts() {
  const c = {};
  // Bütün bilinen odalar üçün (boş olanlar da daxil)
  const allMids = new Set([
    ...Object.keys(rooms),
    '142','217','358','473','591',  // sabit odalar
  ]);
  for (const mid of allMids) {
    const pl = roomPlayers(mid);
    c[mid] = {
      total:   pl.length,
      f:       pl.filter(p => isF(p.gender)).length,
      m:       pl.filter(p => !isF(p.gender)).length,
      // players: client-ə avatar + ad göstərmək üçün
      players: pl.map(p => ({
        id:     p.db_id,
        name:   p.name   || '',
        avatar: p.avatar || null,
        gender: p.gender || 'm',
      })),
    };
  }
  return c;
}

// Hamıya broadcast et
function broadcastCounts() {
  io.emit('masa_counts', { counts: masaCounts() });
}

// Yalnız bir socket-ə göndər (join zamanı)
function sendCountsToSocket(socket) {
  socket.emit('masa_counts', { counts: masaCounts() });
}

// ── Turn idarəsi ──
function getTurn(mid) {
  if (!turnState[mid]) {
    turnState[mid] = {
      spinQueue:   [],
      targetQueue: [],
      current:     null,
      timer:       null,
      pending:     null,
    };
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

  io.to(mid).emit('your_turn', {
    userId:   parseInt(spinnerId),
    targetId: 'pu' + targetId,
    masaId:   mid,
  });

  ts.timer = setTimeout(() => {
    if (getTurn(mid).current !== spinnerId) return;
    io.to(mid).emit('auto_spin', { userId: parseInt(spinnerId), masaId: mid });
    setTimeout(() => {
      const ts2 = getTurn(mid);
      if (ts2.current === spinnerId) {
        ts2.current = null;
        nextTurn(mid);
      }
    }, 5000);
  }, 12000);
}

function startIfReady(mid) {
  const ts = getTurn(mid);
  if (!ts.current && roomPlayers(mid).length >= 2) {
    setTimeout(() => nextTurn(mid), 800);
  }
}

// ── Odadan çıxart (disconnect və ya leave üçün ortaq) ──
function removePlayerFromRoom(uid, mid, socketId) {
  const room = getRoom(mid);

  // Başqa socket ilə artıq yenidən qoşulubsa yoksay
  if (room[uid] && room[uid].socketId !== socketId) return;

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

  io.to(mid).emit('player_leave', { userId: parseInt(uid), masaId: mid });
  io.to(mid).emit('players',      { data: pl, masaId: mid });
  io.to(mid).emit('online_sayi',  { value: pl.length });

  if (pl.length === 0) {
    delete rooms[mid];
    delete musicState[mid];
    delete turnState[mid];
    delete bottleState[mid];
    delete chatHistory[mid];
  } else if (pl.length === 1) {
    if (ts.timer)   { clearTimeout(ts.timer);   ts.timer   = null; }
    if (ts.pending) { clearTimeout(ts.pending); ts.pending = null; }
    ts.current     = null;
    ts.spinQueue   = [];
    ts.targetQueue = [];
  }

  broadcastCounts();
}

// ── Socket bağlantıları ──
io.on('connection', (socket) => {

  // Odaya qoşul
  socket.on('join', (data) => {
    if (!data.userId || !data.masaId) return;
    if (!data.name || data.name === 'undefined' || data.name === 'null') return;
    const uid = String(data.userId);
    const mid = String(data.masaId);

    // Köhnə odadan çıx (masa dəyişdikdə)
    const prev = socketRoom[socket.id];
    if (prev && prev.mid && prev.mid !== mid) {
      socket.leave(prev.mid);
      const oldRoom = getRoom(prev.mid);
      if (oldRoom[prev.uid] && oldRoom[prev.uid].socketId === socket.id) {
        // Grace timer varsa ləğv et — masa dəyişdirildi, geri qayıtmayacaq
        if (oldRoom.__graceTimers && oldRoom.__graceTimers[prev.uid]) {
          clearTimeout(oldRoom.__graceTimers[prev.uid]);
          delete oldRoom.__graceTimers[prev.uid];
        }
        removePlayerFromRoom(prev.uid, prev.mid, socket.id);
      }
    }

    socketRoom[socket.id] = { uid, mid };
    socket.join(mid);

    // Grace timer varsa ləğv et (reload geri qayıtdı)
    const roomRef = getRoom(mid);
    if (roomRef.__graceTimers && roomRef.__graceTimers[uid]) {
      clearTimeout(roomRef.__graceTimers[uid]);
      delete roomRef.__graceTimers[uid];
    }

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

    // Şişə vəziyyəti
    if (bottleState[mid]) {
      socket.emit('bottle_change', { src: bottleState[mid] });
    }

    // Musiqi vəziyyəti
    if (musicState[mid]) {
      const ms = musicState[mid];
      socket.emit('music_play', {
        ...ms,
        elapsedOnJoin: Math.floor((Date.now() - ms.startedAt) / 1000),
      });
    }

    // Chat tarixi — yalnız bu socket-ə, bir dəfə
    const hist = chatHistory[mid];
    if (hist && hist.length) {
      socket.emit('chat_history', { messages: hist });
    }

    // Oyuncu siyahısı — HAMIYA (masaId ilə birlikdə)
    const pl = roomPlayers(mid);
    io.to(mid).emit('players', { data: pl, masaId: mid });

    // Digərlərinə player_join bildirimi (özünə yox)
    socket.to(mid).emit('player_join', {
      userId:    parseInt(uid),
      name:      data.name      || '',
      avatar:    data.avatar    || null,
      gender:    data.gender    || 'm',
      isVip:     data.isVip     || 0,
      cercveSrc: data.cercveSrc || '',
      masaId:    mid,
    });

    io.to(mid).emit('online_sayi', { value: pl.length });

    // Yalnız bu socket-ə bütün masaların sayılarını göndər
    sendCountsToSocket(socket);
    // Digərlərinə də broadcast et (yeni oyuncu gəldi)
    socket.to('*').emit('masa_counts', { counts: masaCounts() });

    startIfReady(mid);
  });

  // Açıq leave — tab bağlananda client göndərir
  socket.on('leave', (data) => {
    if (!data.userId || !data.masaId) return;
    const uid = String(data.userId);
    const mid = String(data.masaId);
    const room = getRoom(mid);

    // Grace timer varsa ləğv et — bu real leave-dir
    if (room.__graceTimers && room.__graceTimers[uid]) {
      clearTimeout(room.__graceTimers[uid]);
      delete room.__graceTimers[uid];
    }

    if (room[uid] && room[uid].socketId === socket.id) {
      removePlayerFromRoom(uid, mid, socket.id);
    }
  });

  // Bütün masaların sayılarını təlb et (client get_masa_counts göndərəndə)
  socket.on('get_masa_counts', () => {
    sendCountsToSocket(socket);
  });

  // Chat
  socket.on('chat', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    socket.to(mid).emit('chat', data);

    if (!chatHistory[mid]) chatHistory[mid] = [];
    const hist = chatHistory[mid];
    const key  = String(data.userId) + '|' + String(data.text);
    const recent = hist.slice(-5);
    if (!recent.some(m => String(m.userId) + '|' + String(m.text) === key)) {
      hist.push({
        userId:    data.userId,
        name:      data.name      || '',
        avatar:    data.avatar    || '',
        text:      data.text      || '',
        isVip:     data.isVip     || 0,
        gender:    data.gender    || '',
        cercveSrc: data.cercveSrc || '',
      });
      if (hist.length > 60) hist.shift();
    }
  });

  // Şişə çevrildi
  socket.on('spin', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    const ts  = getTurn(mid);
    if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }
    socket.to(mid).emit('spin', data);
  });

  // Kiss seçimi
  socket.on('kiss', (data) => {
    if (!data.masaId) return;
    socket.to(String(data.masaId)).emit('kiss', data);
  });

  // Kiss popup bağlandı — növbəti tur
  socket.on('next_turn_ready', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    const ts  = getTurn(mid);

    if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }
    if (ts.pending) { clearTimeout(ts.pending); ts.pending = null; }
    ts.pending = setTimeout(() => {
      ts.pending = null;
      ts.current = null;
      nextTurn(mid);
    }, 500);
  });

  // Digər eventlər
  socket.on('gift',           (d) => { if (d.masaId) socket.to(String(d.masaId)).emit('gift', d); });
  socket.on('profile_like',   (d) => { if (d.masaId) socket.to(String(d.masaId)).emit('profile_like',   d); });
  socket.on('profile_unlike', (d) => { if (d.masaId) socket.to(String(d.masaId)).emit('profile_unlike', d); });
  socket.on('bildiris',       (d) => { if (d.masaId) io.to(String(d.masaId)).emit('bildiris', d); });
  socket.on('ping',           ()  => socket.emit('pong'));
  socket.on('your_turn',      ()  => {});
  socket.on('auto_spin',      (d) => { if (d.masaId) socket.to(String(d.masaId)).emit('auto_spin', d); });

  socket.on('bottle_change', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    if (data.src) bottleState[mid] = data.src;
    socket.to(mid).emit('bottle_change', data);
  });

  socket.on('cercve_change', (data) => {
    if (!data.masaId) return;
    const mid  = String(data.masaId);
    const uid  = String(data.userId);
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

  // Bağlantı kəsildi
  socket.on('disconnect', () => {
    const entry = socketRoom[socket.id];
    delete socketRoom[socket.id];
    if (!entry) return;

    const { uid, mid } = entry;
    const room = getRoom(mid);

    // Eyni uid yeni socket ilə artıq qoşulubsa — köhnə disconnect-i yoksay
    if (room[uid] && room[uid].socketId !== socket.id) return;

    // ── Reconnect grace period: 6 saniyə gözlə ──
    if (!room.__graceTimers) room.__graceTimers = {};
    if (room.__graceTimers[uid]) {
      clearTimeout(room.__graceTimers[uid]);
    }

    room.__graceTimers[uid] = setTimeout(() => {
      const r = getRoom(mid);
      if (r.__graceTimers) delete r.__graceTimers[uid];
      // Grace müddətində yenidən qoşuldusa artıq yeni socketId var
      if (r[uid] && r[uid].socketId !== socket.id) return;
      removePlayerFromRoom(uid, mid, socket.id);
    }, 6000);
  });
});

// Memory leak qoruması — hər 10 dəqiqədə boş odaları təmizlə
setInterval(() => {
  for (const mid of Object.keys(rooms)) {
    if (roomPlayers(mid).length === 0) {
      delete rooms[mid];
      delete musicState[mid];
      delete turnState[mid];
      delete bottleState[mid];
      delete chatHistory[mid];
    }
  }
  // Ölü socket-ləri sil
  for (const sid of Object.keys(socketRoom)) {
    if (!io.sockets.sockets.has(sid)) delete socketRoom[sid];
  }
  // legacy disconnectTimers təmizlə
  for (const key of Object.keys(disconnectTimers)) {
    clearTimeout(disconnectTimers[key]);
    delete disconnectTimers[key];
  }
}, 10 * 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`✅ Socket server running on port ${PORT}`);
});

process.on('uncaughtException',  err => console.error('❌ Uncaught:', err));
process.on('unhandledRejection', err => console.error('❌ Rejection:', err));
