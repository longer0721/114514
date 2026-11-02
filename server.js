// 情侣软件后端 v6 —— 邀请码绑定 + 持久化 + 纪念日 + 昵称头像 + 云部署(DATA_FILE 可配)
// 绑定关系/想念值/留言/纪念日/昵称头像全部落盘，重启服务器不丢；设备重开自动回到原房间
// 运行: node server.js  →  http://127.0.0.1:3000
// 云部署: DATA_FILE=/data/data.json node server.js(Docker 挂载卷持久化)
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname)));

// ============ 持久化存储 ============
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let db = { players: {}, rooms: {} };
// db.players[clientId] = { name, code, avatar }
// db.rooms[code] = { names:[], since, sinceDate:'YYYY-MM-DD', profiles:{name:avatar},
//                    misses:{ 'YYYY-MM-DD': { name: value } }, leaves:[{from,text,time,ts}] }

function load() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log('[db] loaded', DATA_FILE);
  } catch (e) {
    db = { players: {}, rooms: {} };
    console.log('[db] no data file, fresh start');
  }
}
function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error('[db] save failed', e); }
}

function todayKey() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function genCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += Math.floor(Math.random() * 10);
  return c;
}

// 在一起天数:dateStr('YYYY-MM-DD') → 当天算第 1 天
function calcDays(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const now = new Date();
  const diff = Math.floor((now.getTime() - start.getTime()) / 86400000);
  return diff + 1;
}

function roomState(code) {
  const room = db.rooms[code];
  if (!room) return { misses: {}, leaves: [], sinceDate: null, days: null };
  return {
    misses: room.misses || {},
    leaves: (room.leaves || []).slice(-50),
    sinceDate: room.sinceDate || null,
    days: calcDays(room.sinceDate)
  };
}

// ============ 在线状态(内存) ============
const online = new Map(); // code -> Map(name -> Set(socketId))

function broadcastPeers(code) {
  const members = online.get(code);
  if (!members) return;
  const peers = [...members.keys()];
  const room = db.rooms[code];
  io.to('room:' + code).emit('peers', { code, peers, profiles: (room && room.profiles) || {} });
}

function attachSocket(socket, code, name, clientId) {
  socket.data.roomCode = code;
  socket.data.name = name;
  socket.data.clientId = clientId;
  socket.join('room:' + code);
  if (!online.has(code)) online.set(code, new Map());
  const members = online.get(code);
  if (!members.has(name)) members.set(name, new Set());
  members.get(name).add(socket.id);
}

// ============ Socket 事件 ============
io.on('connection', (socket) => {
  // 创建房间(生成邀请码)
  socket.on('create', ({ clientId, name }) => {
    let code;
    do { code = genCode(); } while (db.rooms[code]);
    db.rooms[code] = { names: [name], since: Date.now(), sinceDate: null, profiles: {}, misses: {}, leaves: [] };
    db.players[clientId] = { name, code, avatar: '' };
    save();
    attachSocket(socket, code, name, clientId);
    socket.emit('created', { code, peers: [name], state: roomState(code), profiles: db.rooms[code].profiles || {} });
    broadcastPeers(code);
    console.log('[create]', name, clientId, '-> room', code);
  });

  // 输入邀请码加入
  socket.on('joinRoom', ({ clientId, code, name }) => {
    const room = db.rooms[code];
    if (!room) { socket.emit('joinError', { message: '邀请码不存在，检查一下是不是打错了' }); return; }
    const player = db.players[clientId];
    const isMember = room.names.includes(name) || (player && player.code === code);
    if (!isMember && room.names.length >= 2) {
      socket.emit('joinError', { message: '这个房间已经有两个人啦 😅' });
      return;
    }
    if (!room.names.includes(name)) room.names.push(name);
    if (player) { player.code = code; player.name = name; if (player.avatar === undefined) player.avatar = ''; }
    else { db.players[clientId] = { name, code, avatar: '' }; }
    if (!room.profiles) room.profiles = {};
    if (player && player.avatar) room.profiles[name] = player.avatar;
    save();
    attachSocket(socket, code, name, clientId);
    socket.emit('joined', { code, peers: room.names, state: roomState(code), rejoin: false, profiles: room.profiles || {} });
    io.to('room:' + code).except(socket.id).emit('partnerJoined', { name, code });
    broadcastPeers(code);
    console.log('[join]', name, clientId, '-> room', code);
  });

  // 设备重开 → 自动回到原房间(默认一直进)
  socket.on('autoRejoin', ({ clientId, name }) => {
    const player = db.players[clientId];
    if (!player || !player.code) { socket.emit('noMapping'); return; }
    let code = player.code;
    if (!db.rooms[code]) {
      // 房间已销毁 → 用原来的码重建(对方下次回来还能进同一个码)
      db.rooms[code] = { names: [player.name], since: Date.now(), sinceDate: null, profiles: {}, misses: {}, leaves: [] };
    }
    const room = db.rooms[code];
    if (!room.names.includes(name)) room.names.push(name);
    player.name = name;
    if (player.avatar === undefined) player.avatar = '';
    db.players[clientId] = player;
    if (!room.profiles) room.profiles = {};
    if (player.avatar) room.profiles[name] = player.avatar;
    save();
    attachSocket(socket, code, name, clientId);
    socket.emit('joined', { code, peers: room.names, state: roomState(code), rejoin: true, profiles: room.profiles || {} });
    io.to('room:' + code).except(socket.id).emit('partnerJoined', { name, code });
    broadcastPeers(code);
    console.log('[rejoin]', name, clientId, '-> room', code);
  });

  // 想念值(按日期持久化)
  socket.on('miss', ({ value }) => {
    const code = socket.data.roomCode;
    const room = code && db.rooms[code];
    if (!room) return;
    const k = todayKey();
    if (!room.misses[k]) room.misses[k] = {};
    room.misses[k][socket.data.name] = value;
    save();
    io.to('room:' + code).emit('miss', { from: socket.data.name, value });
  });

  // 留言(持久化;ts=客户端时间戳,离线重放去重)
  socket.on('leave', ({ text, time, ts }) => {
    const code = socket.data.roomCode;
    const room = code && db.rooms[code];
    if (!room || !text) return;
    const clientTs = ts ? Number(ts) : Date.now();
    if (clientTs && room.leaves.some(l => l.from === socket.data.name && l.ts === clientTs)) return; // 重复重放,忽略
    room.leaves.push({ from: socket.data.name, text: String(text).slice(0, 120), time: time || '', ts: clientTs });
    save();
    io.to('room:' + code).emit('leave', { from: socket.data.name, text, time: time || '' });
  });

  // 设置在一起的日子(任一方可设,两端同步显示+落盘)
  socket.on('setSince', ({ date }) => {
    const code = socket.data.roomCode;
    const room = code && db.rooms[code];
    if (!room) return;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      socket.emit('sinceErr', { message: '日期格式不对，要用 YYYY-MM-DD' });
      return;
    }
    room.sinceDate = date;
    save();
    io.to('room:' + code).emit('since', { date, days: calcDays(date) });
    console.log('[since] room', code, '->', date, '(' + calcDays(date) + ' days)');
  });

  // 设置昵称/头像(任一方可改,对方实时看到新名字新头像)
  socket.on('setProfile', ({ name, avatar }) => {
    const code = socket.data.roomCode;
    const room = code && db.rooms[code];
    if (!room) return;
    const oldName = socket.data.name;
    const newName = String(name || '').slice(0, 12).trim() || oldName;
    const newAvatar = String(avatar || '').slice(0, 8);

    // 重名保护:TA 正在用的名字不能抢
    if (newName !== oldName && room.names.includes(newName)) {
      socket.emit('profileErr', { message: '这个名字 TA 正在用呢，换一个吧 😅' });
      return;
    }

    // 更新玩家档案
    const player = db.players[socket.data.clientId];
    if (player) { player.name = newName; player.avatar = newAvatar; }
    if (!room.profiles) room.profiles = {};

    if (newName !== oldName) {
      // 房间成员名单:旧名 → 新名
      const idx = room.names.indexOf(oldName);
      if (idx !== -1) room.names[idx] = newName;
      // 在线表:旧名 → 新名
      const members = online.get(code);
      if (members && members.has(oldName)) {
        const ids = members.get(oldName);
        members.delete(oldName);
        if (!members.has(newName)) members.set(newName, new Set());
        ids.forEach(id => members.get(newName).add(id));
      }
      delete room.profiles[oldName];
      // 历史数据跟着人走:想念值/留言里的旧名 → 新名
      Object.keys(room.misses || {}).forEach(d => {
        const day = room.misses[d];
        if (day[oldName] !== undefined) { day[newName] = day[oldName]; delete day[oldName]; }
      });
      (room.leaves || []).forEach(l => { if (l.from === oldName) l.from = newName; });
    }
    room.profiles[newName] = newAvatar;
    socket.data.name = newName;
    save();
    io.to('room:' + code).emit('profile', { oldName, name: newName, avatar: newAvatar });
    broadcastPeers(code);
    console.log('[profile]', oldName, '->', newName, newAvatar ? '(' + newAvatar + ')' : '(no avatar)', 'room', code);
  });

  // 断开 → 从在线表移除并广播
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const name = socket.data.name;
    if (code && name && online.has(code)) {
      const members = online.get(code);
      if (members.has(name)) {
        const ids = members.get(name);
        ids.delete(socket.id);
        if (ids.size === 0) members.delete(name);
      }
      if (members.size === 0) online.delete(code);
      broadcastPeers(code);
      console.log('[leave]', name, 'offline (room', code, 'still persisted)');
    }
  });
});

load();

const PORT = 3000;
function lanIP() {
  const ifs = require('os').networkInterfaces();
  for (const k in ifs) {
    for (const i of ifs[k]) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}
app.get('/ip', (req, res) => {
  res.json({ ip: lanIP(), url: 'http://' + lanIP() + ':' + PORT });
});
app.get('/health', (req, res) => {
  res.json({ ok: true, rooms: Object.keys(db.rooms).length, data: DATA_FILE });
});
server.listen(PORT, () => {
  console.log('couple-app server v5: 0.0.0.0:' + PORT);
  console.log('PC local:     http://127.0.0.1:' + PORT);
  console.log('Phone access: http://' + lanIP() + ':' + PORT + '/?u=name  (same WiFi)');
  console.log('Window 1 (me):    http://127.0.0.1:3000/?u=me');
  console.log('Window 2 (lover): http://127.0.0.1:3000/?u=lover');
});