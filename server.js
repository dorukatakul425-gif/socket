const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 2223;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bottle Game WS Server OK');
});

const wss = new WebSocket.Server({ server, handleProtocols: () => 'binary' });

// Decode message from client
function decodeMsg(data) {
  try {
    const arr = new Uint8Array(data);
    const len = arr[0] * 256 + arr[1];
    let str = '';
    for (let i = 2; i < arr.length; i++) str += String.fromCharCode(arr[i]);
    const utf8 = decodeURIComponent(escape(str));
    return JSON.parse(utf8);
  } catch (e) {
    return null;
  }
}

// Encode message to client
function encodeMsg(obj) {
  const json = JSON.stringify(obj);
  const utf8s = unescape(encodeURIComponent(json));
  const a = Math.floor(utf8s.length / 256);
  const b = utf8s.length % 256;
  const str = String.fromCharCode(a, b) + utf8s;
  const data = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) data[i] = str.charCodeAt(i);
  return Buffer.from(data);
}

// Fake user database
const users = {};

function getOrCreateUser(userId) {
  if (!users[userId]) {
    users[userId] = {
      id: userId,
      name: 'Player ' + userId,
      photo: '',
      gold: 1000,
      level: 1,
      xp: 0,
      bottle: 'bottle_default',
      online: true,
      country: 'AZ',
      locale: 'en',
      achievements: [],
      boosters: {},
      stones: 0,
      tokens: 0,
    };
  }
  return users[userId];
}

wss.on('connection', (ws, req) => {
  console.log('Client connected:', req.url);
  let userId = null;
  let sessionId = 'sess_' + Date.now();

  ws.on('message', (data) => {
    const msg = decodeMsg(data);
    if (!msg) return;
    console.log('recv:', JSON.stringify(msg));

    const { method, params } = msg;

    switch (method) {
      case 'auth': {
        userId = params.userId || params.id || ('user_' + Date.now());
        const user = getOrCreateUser(userId);
        ws.send(encodeMsg({
          method: 'auth',
          params: {
            ok: true,
            session: sessionId,
            user: user,
            config: {
              spinTimeout: 5000,
              chatEnabled: true,
              giftsEnabled: true,
            }
          }
        }));
        // Send online users
        ws.send(encodeMsg({
          method: 'onlineUsers',
          params: { count: 1, users: [user] }
        }));
        break;
      }

      case 'spin': {
        // Return a random user to spin to
        const user = getOrCreateUser(userId);
        const target = {
          id: 'bot_1',
          name: 'Demo User',
          photo: '',
          gold: 500,
          level: 1,
          country: 'AZ',
          bottle: 'bottle_default',
        };
        ws.send(encodeMsg({
          method: 'spin',
          params: {
            ok: true,
            target: target,
            angle: Math.random() * 360,
          }
        }));
        break;
      }

      case 'ping': {
        ws.send(encodeMsg({ method: 'pong', params: {} }));
        break;
      }

      case 'getUsers': {
        const user = getOrCreateUser(userId);
        ws.send(encodeMsg({
          method: 'getUsers',
          params: { users: [user] }
        }));
        break;
      }

      case 'sendGift': {
        ws.send(encodeMsg({
          method: 'sendGift',
          params: { ok: true }
        }));
        break;
      }

      default: {
        // Echo back unknown methods
        ws.send(encodeMsg({
          method: method,
          params: { ok: true }
        }));
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected:', userId);
  });

  ws.on('error', (err) => {
    console.log('WS error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
