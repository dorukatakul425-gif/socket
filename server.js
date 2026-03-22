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
  pingInterval: 20000,   // hər 20s-dən bir ping — Railway 30s timeout-dan əvvəl
  pingTimeout:  60000,   // Railway-in proxy timeout-una uyğun
  maxHttpBufferSize: 1e6,
  allowEIO3: true,       // köhnə socket.io client-larla uyğunluq
});

// ── State ──
const rooms       = {};  // mid -> { uid -> playerObj }
const musicState  = {};  // mid -> musicData
const bottleState = {};  // mid -> bottleSrc
const chatHistory = {};  // mid -> [msgObj]
const turnState   = {};  // mid -> turnObj
const socketRoom  = {};  // socketId -> { uid, mid }

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

// ── Masa sayısı ──
function masaCounts() {
  const c = {};
  for (const mid of Object.keys(rooms)) {
    const pl = roomPlayers(mid);
    if (!pl.length) continue;
    const isF = g => ['f','female','qiz','qadin','kadin','k'].includes((g||'').toLowerCase().trim());
    c[mid] = {
      total: pl.length,
      f: pl.filter(p => isF(p.gender)).length,
      m: pl.filter(p => !isF(p.gender)).length,
    };
  }
  return c;
}
function broadcastCounts() {
  io.emit('masa_counts', { counts: masaCounts() });
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

  // Spin queue — odada olmayan uid-ləri çıxar, boşsa yenidən doldur
  ts.spinQueue = ts.spinQueue.filter(id => inRoom.has(id));
  if (!ts.spinQueue.length) ts.spinQueue = shuffle(ids);
  const spinnerId = ts.spinQueue.shift();
  ts.current = spinnerId;

  // Target queue — spinner xaric
  const others = ids.filter(id => id !== spinnerId);
  ts.targetQueue = ts.targetQueue.filter(id => others.includes(id));
  if (!ts.targetQueue.length) ts.targetQueue = shuffle(others);
  const targetId = ts.targetQueue.shift();

  // your_turn göndər — spinner + target birlikdə
  io.to(mid).emit('your_turn', {
    userId:   parseInt(spinnerId),
    targetId: 'pu' + targetId,
    masaId:   mid,
  });

  // 12s spin gəlməzsə → auto_spin → 5s sonra növbəti tur
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

// ── Socket bağlantıları ──
io.on('connection', (socket) => {

  // Odaya qoşul
  socket.on('join', (data) => {
    if (!data.userId || !data.masaId) return;
    const uid = String(data.userId);
    const mid = String(data.masaId);

    // Köhnə socket varsa — yeni socketId-ni saxla, state-i qaldır
    const prev = socketRoom[socket.id];
    if (prev && prev.uid === uid && prev.mid === mid) {
      // Eyni socket yenidən join etdi — yoksay
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

    // Oyuncu siyahısı — HAMIYA göndər (özü də daxil)
    const pl = roomPlayers(mid);
    io.to(mid).emit('players', { data: pl });

    // Digərlərinə player_join bildirimi (özünə yox)
    socket.to(mid).emit('player_join', {
      userId:    parseInt(uid),
      name:      data.name      || '',
      avatar:    data.avatar    || null,
      gender:    data.gender    || 'm',
      isVip:     data.isVip     || 0,
      cercveSrc: data.cercveSrc || '',
    });

    io.to(mid).emit('online_sayi', { value: pl.length });
    broadcastCounts();
    startIfReady(mid);
  });

  // Chat — yalnız digərlərinə
  socket.on('chat', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);

    // Yalnız digərlərinə göndər — göndərənə yox
    socket.to(mid).emit('chat', data);

    // Tarixə yaz — duplicate yoxlaması (son 5-də eyni varsa əlavə etmə)
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

  // Şişə çevrildi — timer-ı durdur, digərlərinə göndər
  socket.on('spin', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    const ts  = getTurn(mid);
    if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }
    socket.to(mid).emit('spin', data);
  });

  // Kiss seçimi — yalnız digərlərinə
  socket.on('kiss', (data) => {
    if (!data.masaId) return;
    socket.to(String(data.masaId)).emit('kiss', data);
  });

  // Kiss popup bağlandı — növbəti tur başlat
  socket.on('next_turn_ready', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    const ts  = getTurn(mid);

    if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }

    // Debounce — eyni anda çoxlu gəlsə yalnız bir dəfə işlə
    if (ts.pending) return;
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
  socket.on('your_turn',      ()  => {}); // server idarə edir
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
  socket.on('disconnect', (reason) => {
    const entry = socketRoom[socket.id];
    delete socketRoom[socket.id];
    if (!entry) return;

    const { uid, mid } = entry;
    const room = getRoom(mid);

    // Eyni uid yeni socket ilə artıq qoşulubsa — köhnə disconnect-i yoksay
    if (room[uid] && room[uid].socketId !== socket.id) {
      return;
    }

    delete room[uid];

    const ts = getTurn(mid);

    // Sırası olan kişi çıxdısa — sıranı keç
    if (ts.current === uid) {
      if (ts.timer)   { clearTimeout(ts.timer);   ts.timer   = null; }
      if (ts.pending) { clearTimeout(ts.pending); ts.pending = null; }
      ts.current = null;
      setTimeout(() => nextTurn(mid), 500);
    }

    ts.spinQueue   = ts.spinQueue.filter(id => id !== uid);
    ts.targetQueue = ts.targetQueue.filter(id => id !== uid);

    const pl = roomPlayers(mid);

    // Çıxan oyunçunu hamıya bildir
    socket.to(mid).emit('player_leave', { userId: parseInt(uid) });

    // Yenilənmiş siyahını hamıya göndər
    io.to(mid).emit('players',     { data: pl });
    io.to(mid).emit('online_sayi', { value: pl.length });

    if (pl.length === 0) {
      // Oda tamamilə boşaldı — hər şeyi sil
      delete rooms[mid];
      delete musicState[mid];
      delete turnState[mid];
      delete bottleState[mid];
      delete chatHistory[mid];
    } else if (pl.length === 1) {
      // 1 nəfər qaldı — sıranı dondur
      if (ts.timer)   { clearTimeout(ts.timer);   ts.timer   = null; }
      if (ts.pending) { clearTimeout(ts.pending); ts.pending = null; }
      ts.current     = null;
      ts.spinQueue   = [];
      ts.targetQueue = [];
    }

    broadcastCounts();
  });
});

// Memory leak qoruması — hər 10 dəqiqədə boş odaları təmizlə
setInterval(() => {
  let cleaned = 0;
  for (const mid of Object.keys(rooms)) {
    if (roomPlayers(mid).length === 0) {
      delete rooms[mid];
      delete musicState[mid];
      delete turnState[mid];
      delete bottleState[mid];
      delete chatHistory[mid];
      cleaned++;
    }
  }
  // Ölü socket-ləri socketRoom-dan sil
  for (const sid of Object.keys(socketRoom)) {
    if (!io.sockets.sockets.has(sid)) delete socketRoom[sid];
  }
}, 10 * 60 * 1000);

httpServer.listen(PORT, () => {
});
