const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const rooms    = new Map();
const wsToRoom = new Map();

const COLORS = ['#c97060','#e8a44a','#6a9fd8','#7cb87c','#a880c8','#d4a060','#60a8c9','#c9b060'];
const EMOJIS = ['🦊','🐻','🐺','🦁','🐸','🐧','🦝','🐨'];

function genCode() { return Math.random().toString(36).substr(2,6).toUpperCase(); }
function sendTo(ws, msg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function broadcastRoom(room, msg, excludeId = null) {
  const p = JSON.stringify(msg);
  room.members.forEach(m => { if (m.wsId !== excludeId && m.ws.readyState === WebSocket.OPEN) m.ws.send(p); });
}
function computePlayback(room) {
  const pb = room.playback;
  if (!pb.isPlaying || !pb.startedAt) return { ...pb };
  return { ...pb, position: pb.position + (Date.now() - pb.startedAt) };
}
function roomSnapshot(room) {
  return {
    type: 'room_snapshot', roomName: room.name, roomCode: room.code,
    members: Array.from(room.members.values()).map(m => ({ wsId: m.wsId, name: m.name, color: m.color, emoji: m.emoji })),
    queue: room.queue, playback: computePlayback(room)
  };
}

// ── WebSocket ─────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.wsId = randomUUID();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } handle(ws, m); });
  ws.on('close', () => disconnect(ws));
  ws.on('error', () => disconnect(ws));
});

// Server heartbeat — kills ghost connections
const hb = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false; ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(hb));

// ── handler ───────────────────────────────────────────────────
function handle(ws, msg) {
  const { type } = msg;

  if (type === 'join') {
    const { roomCode, roomName, userName, rejoin } = msg;
    let code = (roomCode || '').toUpperCase().trim();
    let room;

    if (code && rooms.has(code)) {
      room = rooms.get(code);
    } else if (!code && roomName) {
      code = genCode();
      room = { name: roomName, code, createdAt: Date.now(), members: new Map(), queue: [],
               playback: { currentIndex: -1, isPlaying: false, position: 0, startedAt: null },
               trackEndedGuard: -1 };
      rooms.set(code, room);
    } else if (code && !rooms.has(code)) {
      sendTo(ws, { type: 'error', message: 'Room not found. It may have closed — create a new one.' }); return;
    } else {
      sendTo(ws, { type: 'error', message: 'Invalid request.' }); return;
    }

    const ci = room.members.size % COLORS.length;
    const member = { ws, wsId: ws.wsId, name: userName || 'Anonymous', color: COLORS[ci], emoji: EMOJIS[ci] };
    room.members.set(ws.wsId, member);
    wsToRoom.set(ws.wsId, code);

    sendTo(ws, { ...roomSnapshot(room), yourWsId: ws.wsId, yourColor: member.color, yourEmoji: member.emoji });
    broadcastRoom(room, { type: 'member_joined', member: { wsId: member.wsId, name: member.name, color: member.color, emoji: member.emoji } }, ws.wsId);
    broadcastRoom(room, { type: 'chat_system', text: rejoin ? `${member.name} reconnected 🔄` : `${member.name} joined the room 🔥` });
    console.log(`[${code}] ${member.name} joined — ${room.members.size} in room`);
    return;
  }

  const code = wsToRoom.get(ws.wsId);
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  const member = room.members.get(ws.wsId);
  if (!member) return;

  if (type === 'ping') { sendTo(ws, { type: 'pong' }); return; }

  if (type === 'queue_add') {
    const item = { id: randomUUID(), url: msg.url, title: msg.title || 'Unknown',
                   artist: msg.artist || 'Unknown', art: msg.art || '', addedBy: member.name };
    room.queue.push(item);
    broadcastRoom(room, { type: 'queue_add', item });
    if (room.playback.currentIndex === -1) {
      const idx = room.queue.length - 1;
      room.playback = { currentIndex: idx, isPlaying: true, position: 0, startedAt: Date.now() };
      broadcastRoom(room, { type: 'playback_update', playback: computePlayback(room) });
      broadcastRoom(room, { type: 'chat_system', text: `🎵 Now playing: ${item.title}` });
    }
    return;
  }

  if (type === 'queue_remove') {
    const idx = room.queue.findIndex(i => i.id === msg.itemId);
    if (idx === -1) return;
    room.queue.splice(idx, 1);
    let ci = room.playback.currentIndex;
    if (room.queue.length === 0) {
      room.playback = { currentIndex: -1, isPlaying: false, position: 0, startedAt: null };
    } else {
      if (idx < ci) ci--;
      else if (idx === ci) ci = Math.min(ci, room.queue.length - 1);
      room.playback = { ...computePlayback(room), currentIndex: ci };
      if (room.playback.isPlaying) room.playback.startedAt = Date.now();
    }
    broadcastRoom(room, { type: 'queue_remove', itemId: msg.itemId });
    broadcastRoom(room, { type: 'playback_update', playback: computePlayback(room) });
    return;
  }

  if (type === 'play_index') {
    const idx = msg.index;
    if (idx < 0 || idx >= room.queue.length) return;
    room.trackEndedGuard = -1;
    room.playback = { currentIndex: idx, isPlaying: true, position: 0, startedAt: Date.now() };
    broadcastRoom(room, { type: 'playback_update', playback: computePlayback(room) });
    broadcastRoom(room, { type: 'chat_system', text: `🎵 Now playing: ${room.queue[idx].title}` });
    return;
  }

  if (type === 'toggle_play') {
    const pb = computePlayback(room);
    room.playback = pb.isPlaying
      ? { ...pb, isPlaying: false, startedAt: null }
      : { ...pb, isPlaying: true, startedAt: Date.now() };
    broadcastRoom(room, { type: 'playback_update', playback: computePlayback(room) });
    return;
  }

  if (type === 'seek') {
    const pb = computePlayback(room);
    room.playback = { ...pb, position: msg.position, startedAt: pb.isPlaying ? Date.now() : null };
    broadcastRoom(room, { type: 'playback_update', playback: computePlayback(room) });
    return;
  }

  if (type === 'next_track') {
    const next = room.playback.currentIndex + 1;
    if (next >= room.queue.length) return;
    room.trackEndedGuard = -1;
    room.playback = { currentIndex: next, isPlaying: true, position: 0, startedAt: Date.now() };
    broadcastRoom(room, { type: 'playback_update', playback: computePlayback(room) });
    broadcastRoom(room, { type: 'chat_system', text: `🎵 Now playing: ${room.queue[next].title}` });
    return;
  }

  if (type === 'prev_track') {
    const prev = room.playback.currentIndex - 1;
    if (prev < 0) {
      room.playback = { ...room.playback, position: 0, startedAt: room.playback.isPlaying ? Date.now() : null };
    } else {
      room.playback = { currentIndex: prev, isPlaying: true, position: 0, startedAt: Date.now() };
      broadcastRoom(room, { type: 'chat_system', text: `🎵 Now playing: ${room.queue[prev].title}` });
    }
    broadcastRoom(room, { type: 'playback_update', playback: computePlayback(room) });
    return;
  }

  if (type === 'track_ended') {
    const ci = room.playback.currentIndex;
    // Deduplicate: ignore if already handled for this index
    if (msg.index !== ci || room.trackEndedGuard === ci) return;
    room.trackEndedGuard = ci;
    const next = ci + 1;
    if (next < room.queue.length) {
      room.playback = { currentIndex: next, isPlaying: true, position: 0, startedAt: Date.now() };
      broadcastRoom(room, { type: 'playback_update', playback: computePlayback(room) });
      broadcastRoom(room, { type: 'chat_system', text: `🎵 Now playing: ${room.queue[next].title}` });
    } else {
      room.playback = { currentIndex: ci, isPlaying: false, position: 0, startedAt: null };
      broadcastRoom(room, { type: 'playback_update', playback: computePlayback(room) });
      broadcastRoom(room, { type: 'chat_system', text: '⏹ Queue finished' });
    }
    return;
  }

  if (type === 'chat') {
    const text = (msg.text || '').trim().slice(0, 300);
    if (!text) return;
    broadcastRoom(room, { type: 'chat', wsId: ws.wsId, name: member.name, color: member.color, emoji: member.emoji, text, ts: Date.now() });
    return;
  }
}

function disconnect(ws) {
  const code = wsToRoom.get(ws.wsId);
  wsToRoom.delete(ws.wsId);
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  const member = room.members.get(ws.wsId);
  if (!member) return;
  room.members.delete(ws.wsId);
  broadcastRoom(room, { type: 'member_left', wsId: ws.wsId });
  broadcastRoom(room, { type: 'chat_system', text: `${member.name} left the room` });
  console.log(`[${code}] ${member.name} left — ${room.members.size} remaining`);
  if (room.members.size === 0) {
    setTimeout(() => { if (rooms.has(code) && rooms.get(code).members.size === 0) { rooms.delete(code); console.log(`[${code}] cleaned up`); } }, 10*60*1000);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🪵  Hearth on http://localhost:${PORT}\n`));
