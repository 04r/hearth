const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ── Room state store ──────────────────────────────────────────
// rooms[code] = {
//   name, code, createdAt,
//   members: Map(wsId => { wsId, name, color, emoji }),
//   queue: [ { id, url, title, artist, art, addedBy } ],
//   playback: { currentIndex, isPlaying, position, startedAt }
// }
const rooms = new Map();
const wsToRoom = new Map(); // wsId -> roomCode
const wsToMember = new Map(); // wsId -> memberInfo

const COLORS  = ['#c97060','#e8a44a','#6a9fd8','#7cb87c','#a880c8','#d4a060','#60a8c9','#c9a060'];
const EMOJIS  = ['🦊','🐻','🐺','🦁','🐸','🐧','🦝','🐨'];

function genCode() {
  return Math.random().toString(36).substr(2,6).toUpperCase();
}

// ── Broadcast helpers ─────────────────────────────────────────
function broadcast(room, msg, excludeWsId = null) {
  const payload = JSON.stringify(msg);
  room.members.forEach((member, wsId) => {
    if (wsId === excludeWsId) return;
    const ws = member.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  });
}

function broadcastAll(room, msg) {
  broadcast(room, msg, null);
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── Room snapshot (sent to new joiners) ──────────────────────
function roomSnapshot(room) {
  return {
    type: 'room_snapshot',
    roomName: room.name,
    roomCode: room.code,
    members: Array.from(room.members.values()).map(m => ({
      wsId: m.wsId, name: m.name, color: m.color, emoji: m.emoji
    })),
    queue: room.queue,
    playback: computePlayback(room)
  };
}

// Compute current playback position accounting for elapsed time
function computePlayback(room) {
  const pb = room.playback;
  if (!pb.isPlaying || pb.startedAt === null) {
    return { ...pb };
  }
  const elapsed = Date.now() - pb.startedAt;
  return {
    ...pb,
    position: pb.position + elapsed
  };
}

// ── WebSocket connection handler ──────────────────────────────
wss.on('connection', (ws) => {
  const wsId = randomUUID();
  ws.wsId = wsId;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

function handleMessage(ws, msg) {
  const { type } = msg;

  // ── JOIN ──────────────────────────────────────────────────
  if (type === 'join') {
    const { roomCode, roomName, userName } = msg;
    let code = (roomCode || '').toUpperCase().trim();
    let room;

    if (code && rooms.has(code)) {
      // Joining existing room
      room = rooms.get(code);
    } else if (!code && roomName) {
      // Creating new room
      code = genCode();
      room = {
        name: roomName,
        code,
        createdAt: Date.now(),
        members: new Map(),
        queue: [],
        playback: { currentIndex: -1, isPlaying: false, position: 0, startedAt: null }
      };
      rooms.set(code, room);
    } else if (code && !rooms.has(code)) {
      sendTo(ws, { type: 'error', message: 'Room not found. Check the code and try again.' });
      return;
    } else {
      sendTo(ws, { type: 'error', message: 'Invalid request.' });
      return;
    }

    const colorIdx = room.members.size % COLORS.length;
    const member = {
      ws,
      wsId: ws.wsId,
      name: userName || 'Anonymous',
      color: COLORS[colorIdx],
      emoji: EMOJIS[colorIdx],
      joinedAt: Date.now()
    };

    room.members.set(ws.wsId, member);
    wsToRoom.set(ws.wsId, code);
    wsToMember.set(ws.wsId, member);

    // Send full snapshot to the joiner
    sendTo(ws, {
      ...roomSnapshot(room),
      yourWsId: ws.wsId,
      yourColor: member.color,
      yourEmoji: member.emoji
    });

    // Tell everyone else someone joined
    broadcast(room, {
      type: 'member_joined',
      member: { wsId: member.wsId, name: member.name, color: member.color, emoji: member.emoji }
    }, ws.wsId);

    // System chat
    broadcastAll(room, {
      type: 'chat_system',
      text: `${member.name} joined the room 🔥`
    });

    console.log(`[${code}] ${member.name} joined — ${room.members.size} in room`);
    return;
  }

  // All other messages require room membership
  const roomCode = wsToRoom.get(ws.wsId);
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;
  const member = room.members.get(ws.wsId);
  if (!member) return;

  // ── QUEUE_ADD ────────────────────────────────────────────
  if (type === 'queue_add') {
    const item = {
      id: randomUUID(),
      url: msg.url,
      title: msg.title || 'Unknown',
      artist: msg.artist || 'Unknown',
      art: msg.art || '',
      addedBy: member.name
    };
    room.queue.push(item);

    broadcastAll(room, { type: 'queue_add', item });

    // Auto-play if nothing is playing
    if (room.playback.currentIndex === -1) {
      const newIndex = room.queue.length - 1;
      room.playback = { currentIndex: newIndex, isPlaying: true, position: 0, startedAt: Date.now() };
      broadcastAll(room, { type: 'playback_update', playback: computePlayback(room) });
      broadcastAll(room, { type: 'chat_system', text: `🎵 Now playing: ${item.title}` });
    }
    return;
  }

  // ── QUEUE_REMOVE ─────────────────────────────────────────
  if (type === 'queue_remove') {
    const idx = room.queue.findIndex(i => i.id === msg.itemId);
    if (idx === -1) return;
    const removed = room.queue.splice(idx, 1)[0];

    // Adjust currentIndex
    if (room.playback.currentIndex >= idx) {
      room.playback.currentIndex = Math.max(-1, room.playback.currentIndex - 1);
    }
    if (room.queue.length === 0) {
      room.playback = { currentIndex: -1, isPlaying: false, position: 0, startedAt: null };
    }

    broadcastAll(room, { type: 'queue_remove', itemId: msg.itemId });
    broadcastAll(room, { type: 'playback_update', playback: computePlayback(room) });
    return;
  }

  // ── PLAY_INDEX ───────────────────────────────────────────
  if (type === 'play_index') {
    const idx = msg.index;
    if (idx < 0 || idx >= room.queue.length) return;
    room.playback = { currentIndex: idx, isPlaying: true, position: 0, startedAt: Date.now() };
    const item = room.queue[idx];
    broadcastAll(room, { type: 'playback_update', playback: computePlayback(room) });
    broadcastAll(room, { type: 'chat_system', text: `🎵 Now playing: ${item.title}` });
    return;
  }

  // ── PLAY / PAUSE ─────────────────────────────────────────
  if (type === 'toggle_play') {
    const pb = computePlayback(room); // snapshot current position
    if (pb.isPlaying) {
      room.playback = { ...pb, isPlaying: false, startedAt: null };
    } else {
      room.playback = { ...pb, isPlaying: true, startedAt: Date.now() };
    }
    broadcastAll(room, { type: 'playback_update', playback: computePlayback(room) });
    return;
  }

  // ── SEEK ─────────────────────────────────────────────────
  if (type === 'seek') {
    const pb = computePlayback(room);
    room.playback = {
      ...pb,
      position: msg.position,
      startedAt: pb.isPlaying ? Date.now() : null
    };
    broadcastAll(room, { type: 'playback_update', playback: computePlayback(room) });
    return;
  }

  // ── NEXT / PREV ──────────────────────────────────────────
  if (type === 'next_track') {
    const next = room.playback.currentIndex + 1;
    if (next >= room.queue.length) return;
    room.playback = { currentIndex: next, isPlaying: true, position: 0, startedAt: Date.now() };
    const item = room.queue[next];
    broadcastAll(room, { type: 'playback_update', playback: computePlayback(room) });
    broadcastAll(room, { type: 'chat_system', text: `🎵 Now playing: ${item.title}` });
    return;
  }

  if (type === 'prev_track') {
    const prev = room.playback.currentIndex - 1;
    if (prev < 0) {
      // Restart current
      room.playback = { ...room.playback, position: 0, startedAt: room.playback.isPlaying ? Date.now() : null };
    } else {
      room.playback = { currentIndex: prev, isPlaying: true, position: 0, startedAt: Date.now() };
      const item = room.queue[prev];
      broadcastAll(room, { type: 'chat_system', text: `🎵 Now playing: ${item.title}` });
    }
    broadcastAll(room, { type: 'playback_update', playback: computePlayback(room) });
    return;
  }

  // ── TRACK_ENDED (from client SC widget) ─────────────────
  if (type === 'track_ended') {
    // Only act if the reporter is playing the expected track
    if (msg.index !== room.playback.currentIndex) return;
    const next = room.playback.currentIndex + 1;
    if (next < room.queue.length) {
      room.playback = { currentIndex: next, isPlaying: true, position: 0, startedAt: Date.now() };
      const item = room.queue[next];
      broadcastAll(room, { type: 'playback_update', playback: computePlayback(room) });
      broadcastAll(room, { type: 'chat_system', text: `🎵 Now playing: ${item.title}` });
    } else {
      room.playback = { currentIndex: room.playback.currentIndex, isPlaying: false, position: 0, startedAt: null };
      broadcastAll(room, { type: 'playback_update', playback: computePlayback(room) });
      broadcastAll(room, { type: 'chat_system', text: '⏹ Queue finished' });
    }
    return;
  }

  // ── CHAT ─────────────────────────────────────────────────
  if (type === 'chat') {
    const text = (msg.text || '').trim().slice(0, 300);
    if (!text) return;
    broadcastAll(room, {
      type: 'chat',
      wsId: ws.wsId,
      name: member.name,
      color: member.color,
      emoji: member.emoji,
      text,
      ts: Date.now()
    });
    return;
  }

  // ── PING (keepalive) ─────────────────────────────────────
  if (type === 'ping') {
    sendTo(ws, { type: 'pong' });
    return;
  }
}

function handleDisconnect(ws) {
  const roomCode = wsToRoom.get(ws.wsId);
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;

  const member = room.members.get(ws.wsId);
  if (member) {
    room.members.delete(ws.wsId);
    wsToRoom.delete(ws.wsId);
    wsToMember.delete(ws.wsId);

    broadcast(room, {
      type: 'member_left',
      wsId: ws.wsId,
      name: member.name
    });
    broadcast(room, {
      type: 'chat_system',
      text: `${member.name} left the room`
    });

    console.log(`[${roomCode}] ${member.name} left — ${room.members.size} remaining`);

    // Clean up empty rooms after 10 minutes
    if (room.members.size === 0) {
      setTimeout(() => {
        if (rooms.has(roomCode) && rooms.get(roomCode).members.size === 0) {
          rooms.delete(roomCode);
          console.log(`[${roomCode}] Room deleted (empty)`);
        }
      }, 10 * 60 * 1000);
    }
  }
}

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🪵  Hearth server running on http://localhost:${PORT}\n`);
});
