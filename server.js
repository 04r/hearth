const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
//  IN-MEMORY STORES  (replace with a DB for real production)
// ═══════════════════════════════════════════════════════════════
const users   = new Map(); // username -> { username, passwordHash, roomCode, friends:Set, friendRequests:Set, createdAt }
const rooms   = new Map(); // roomCode -> room object
const sessions= new Map(); // sessionToken -> username

const wsToSession = new Map(); // wsId -> sessionToken
const wsToRoom    = new Map(); // wsId -> roomCode

const COLORS = ['#e8a44a','#c97060','#6a9fd8','#7cb87c','#a880c8','#d4a060','#60a8c9','#e87890'];
const EMOJIS = ['🦊','🐻','🐺','🦁','🐸','🐧','🦝','🐨'];

function genCode(len=6) { return Math.random().toString(36).substr(2,len).toUpperCase(); }
function genToken()     { return randomUUID().replace(/-/g,''); }
function sendTo(ws,msg) { if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function broadcastRoom(room,msg,excludeId=null) {
  const p=JSON.stringify(msg);
  room.members.forEach(m=>{ if(m.wsId!==excludeId && m.ws.readyState===WebSocket.OPEN) m.ws.send(p); });
}
function computePlayback(room) {
  const pb=room.playback;
  if(!pb.isPlaying||!pb.startedAt) return {...pb};
  return {...pb, position: pb.position+(Date.now()-pb.startedAt)};
}

function makeRoom(ownerUsername) {
  const code = genCode(6);
  const room = {
    code, owner: ownerUsername,
    name: `${ownerUsername}'s Room`,
    members: new Map(),
    queue: [],
    playback: { currentIndex:-1, isPlaying:false, position:0, startedAt:null },
    trackEndedGuard: -1,
    // room customization
    decoration: {
      theme: 'cabin',           // theme name
      wallpaper: 'cabin',       // wallpaper key
      widgets: [],              // [{id,type,x,y,data}]
      roomName: `${ownerUsername}'s Room`,
      mood: ''                  // mood text shown in room
    }
  };
  rooms.set(code, room);
  return room;
}

function roomPublicInfo(room) {
  return {
    code: room.code,
    name: room.decoration.roomName || room.name,
    owner: room.owner,
    memberCount: room.members.size,
    decoration: room.decoration
  };
}

function roomSnapshot(room) {
  return {
    type: 'room_snapshot',
    roomCode: room.code,
    roomName: room.decoration.roomName || room.name,
    owner: room.owner,
    members: Array.from(room.members.values()).map(m=>({wsId:m.wsId,username:m.username,color:m.color,emoji:m.emoji})),
    queue: room.queue,
    playback: computePlayback(room),
    decoration: room.decoration
  };
}

// ═══════════════════════════════════════════════════════════════
//  REST API — Auth & Friends
// ═══════════════════════════════════════════════════════════════

// Register
app.post('/api/register', async (req,res)=>{
  const { username, password } = req.body||{};
  if(!username||!password) return res.status(400).json({error:'Username and password required'});
  if(username.length<3||username.length>20) return res.status(400).json({error:'Username must be 3–20 characters'});
  if(!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({error:'Username: letters, numbers, underscores only'});
  if(password.length<4) return res.status(400).json({error:'Password must be at least 4 characters'});
  if(users.has(username.toLowerCase())) return res.status(409).json({error:'Username already taken'});

  const hash = await bcrypt.hash(password,10);
  const user = {
    username: username.toLowerCase(),
    displayName: username,
    passwordHash: hash,
    roomCode: null,
    friends: new Set(),
    friendRequests: new Set(), // incoming
    sentRequests: new Set(),
    createdAt: Date.now()
  };
  users.set(username.toLowerCase(), user);

  // Create their permanent room
  const room = makeRoom(username.toLowerCase());
  user.roomCode = room.code;

  const token = genToken();
  sessions.set(token, username.toLowerCase());

  res.json({ token, username: user.username, displayName: user.displayName, roomCode: room.code });
});

// Login
app.post('/api/login', async (req,res)=>{
  const { username, password } = req.body||{};
  if(!username||!password) return res.status(400).json({error:'Username and password required'});
  const user = users.get(username.toLowerCase());
  if(!user) return res.status(401).json({error:'Invalid username or password'});
  const ok = await bcrypt.compare(password, user.passwordHash);
  if(!ok) return res.status(401).json({error:'Invalid username or password'});

  const token = genToken();
  sessions.set(token, user.username);
  res.json({ token, username: user.username, displayName: user.displayName, roomCode: user.roomCode });
});

// Me
app.get('/api/me', (req,res)=>{
  const token = req.headers['x-token'];
  const username = sessions.get(token);
  if(!username) return res.status(401).json({error:'Not authenticated'});
  const user = users.get(username);
  if(!user) return res.status(401).json({error:'User not found'});
  res.json({
    username: user.username,
    displayName: user.displayName,
    roomCode: user.roomCode,
    friends: Array.from(user.friends),
    friendRequests: Array.from(user.friendRequests),
    sentRequests: Array.from(user.sentRequests)
  });
});

// Friend request
app.post('/api/friends/request', (req,res)=>{
  const token = req.headers['x-token'];
  const myName = sessions.get(token);
  if(!myName) return res.status(401).json({error:'Not authenticated'});
  const { targetUsername } = req.body||{};
  const target = users.get((targetUsername||'').toLowerCase());
  if(!target) return res.status(404).json({error:'User not found'});
  if(target.username===myName) return res.status(400).json({error:"Can't add yourself"});
  const me = users.get(myName);
  if(me.friends.has(target.username)) return res.status(400).json({error:'Already friends'});
  if(me.sentRequests.has(target.username)) return res.status(400).json({error:'Request already sent'});

  // If they already sent us a request, auto-accept
  if(target.sentRequests.has(myName)) {
    me.friends.add(target.username);
    target.friends.add(myName);
    target.sentRequests.delete(myName);
    me.friendRequests.delete(target.username);
    notifyUser(target.username, { type:'friend_accepted', username:myName });
    return res.json({ accepted: true });
  }

  target.friendRequests.add(myName);
  me.sentRequests.add(target.username);
  notifyUser(target.username, { type:'friend_request', from:myName });
  res.json({ sent: true });
});

// Accept friend request
app.post('/api/friends/accept', (req,res)=>{
  const token = req.headers['x-token'];
  const myName = sessions.get(token);
  if(!myName) return res.status(401).json({error:'Not authenticated'});
  const { fromUsername } = req.body||{};
  const me = users.get(myName);
  const them = users.get((fromUsername||'').toLowerCase());
  if(!them) return res.status(404).json({error:'User not found'});
  if(!me.friendRequests.has(them.username)) return res.status(400).json({error:'No request from this user'});

  me.friends.add(them.username);
  them.friends.add(myName);
  me.friendRequests.delete(them.username);
  them.sentRequests.delete(myName);
  notifyUser(them.username, { type:'friend_accepted', username:myName });
  res.json({ accepted: true });
});

// Decline friend request
app.post('/api/friends/decline', (req,res)=>{
  const token = req.headers['x-token'];
  const myName = sessions.get(token);
  if(!myName) return res.status(401).json({error:'Not authenticated'});
  const { fromUsername } = req.body||{};
  const me = users.get(myName);
  const them = users.get((fromUsername||'').toLowerCase());
  if(them) { them.sentRequests.delete(myName); }
  me.friendRequests.delete((fromUsername||'').toLowerCase());
  res.json({ ok: true });
});

// Friends list with online status + room info
app.get('/api/friends', (req,res)=>{
  const token = req.headers['x-token'];
  const myName = sessions.get(token);
  if(!myName) return res.status(401).json({error:'Not authenticated'});
  const me = users.get(myName);
  const list = Array.from(me.friends).map(fn=>{
    const f = users.get(fn);
    if(!f) return null;
    const room = f.roomCode ? rooms.get(f.roomCode) : null;
    const online = room && room.members.size > 0;
    return { username:f.username, displayName:f.displayName, online, roomCode:f.roomCode, roomName: room?.decoration?.roomName||room?.name };
  }).filter(Boolean);
  res.json(list);
});

// Get room info by code
app.get('/api/room/:code', (req,res)=>{
  const room = rooms.get(req.params.code.toUpperCase());
  if(!room) return res.status(404).json({error:'Room not found'});
  res.json(roomPublicInfo(room));
});

// ── SoundCloud search PROXY — fixes CORS completely ──────────
const SC_CLIENT_IDS = [
  'a3e059563d7fd3372b49b37f00a00bcf',
  'iZIs9mchVcX5lhVRyQGGAYlNPa2RS2bx',
  '2t9loNQH90kzJcsFCODdigxfp325aq4z',
  'fDoItMDbsbZz8dY16ZzARCZmzgHBPotA',
];

app.get('/api/search', async (req,res)=>{
  const q = (req.query.q||'').trim();
  if(!q) return res.status(400).json({error:'Query required'});

  for(const id of SC_CLIENT_IDS) {
    try {
      const url = `https://api.soundcloud.com/tracks?q=${encodeURIComponent(q)}&limit=15&client_id=${id}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if(r.ok) {
        const data = await r.json();
        const tracks = (data.collection||data).map(t=>({
          id: t.id,
          title: t.title,
          artist: t.user?.username||'Unknown',
          url: t.permalink_url,
          art: t.artwork_url ? t.artwork_url.replace('-large','-t300x300') : '',
          duration: t.duration
        }));
        return res.json(tracks);
      }
    } catch(e) {}
  }
  res.status(502).json({error:'SoundCloud search unavailable. Try pasting a URL directly.'});
});

// ═══════════════════════════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════════════════════════

// Map username -> connected ws (for direct notifications)
const userWs = new Map();

function notifyUser(username, msg) {
  const ws = userWs.get(username);
  if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', ws=>{
  ws.wsId = randomUUID();
  ws.isAlive = true;
  ws.on('pong', ()=>{ ws.isAlive=true; });
  ws.on('message', raw=>{ let m; try{m=JSON.parse(raw);}catch{return;} handle(ws,m); });
  ws.on('close', ()=>disconnect(ws));
  ws.on('error', ()=>disconnect(ws));
});

const hb = setInterval(()=>{
  wss.clients.forEach(ws=>{ if(!ws.isAlive){ws.terminate();return;} ws.isAlive=false; ws.ping(); });
},30000);
wss.on('close',()=>clearInterval(hb));

function handle(ws,msg) {
  const {type}=msg;

  // ── AUTH via WS ───────────────────────────────────────────
  if(type==='auth') {
    const username = sessions.get(msg.token);
    if(!username) { sendTo(ws,{type:'auth_error',message:'Invalid session'}); return; }
    ws.username = username;
    wsToSession.set(ws.wsId, msg.token);
    userWs.set(username, ws);
    sendTo(ws, {type:'auth_ok', username});
    return;
  }

  // ── JOIN ROOM ─────────────────────────────────────────────
  if(type==='join_room') {
    const username = ws.username;
    if(!username) { sendTo(ws,{type:'error',message:'Not authenticated'}); return; }
    const user = users.get(username);
    const code = (msg.roomCode||'').toUpperCase();
    const room = rooms.get(code);
    if(!room) { sendTo(ws,{type:'error',message:'Room not found'}); return; }

    // Leave current room if in one
    const prevCode = wsToRoom.get(ws.wsId);
    if(prevCode && prevCode!==code) {
      const prevRoom = rooms.get(prevCode);
      if(prevRoom) { prevRoom.members.delete(ws.wsId); broadcastRoom(prevRoom,{type:'member_left',wsId:ws.wsId}); }
    }

    const ci = room.members.size % COLORS.length;
    const member = { ws, wsId:ws.wsId, username, color:COLORS[ci], emoji:EMOJIS[ci] };
    room.members.set(ws.wsId, member);
    wsToRoom.set(ws.wsId, code);

    sendTo(ws, { ...roomSnapshot(room), yourWsId:ws.wsId, yourColor:member.color, yourEmoji:member.emoji });
    broadcastRoom(room, {type:'member_joined',member:{wsId:member.wsId,username,color:member.color,emoji:member.emoji}}, ws.wsId);
    broadcastRoom(room, {type:'chat_system',text:`${username} joined 🔥`});
    return;
  }

  // ── ROOM DECORATION UPDATE ────────────────────────────────
  if(type==='update_decoration') {
    const code = wsToRoom.get(ws.wsId);
    if(!code) return;
    const room = rooms.get(code);
    if(!room || room.owner!==ws.username) { sendTo(ws,{type:'error',message:'Only the room owner can edit decorations'}); return; }
    // Merge decoration
    if(msg.decoration) {
      Object.assign(room.decoration, msg.decoration);
      if(msg.decoration.roomName) room.name = msg.decoration.roomName;
    }
    broadcastRoom(room, {type:'decoration_update', decoration:room.decoration});
    return;
  }

  // ── QUEUE ADD ─────────────────────────────────────────────
  if(type==='queue_add') {
    const code = wsToRoom.get(ws.wsId);
    if(!code) return;
    const room = rooms.get(code);
    if(!room) return;
    const item = { id:randomUUID(), url:msg.url, title:msg.title||'Unknown', artist:msg.artist||'Unknown', art:msg.art||'', addedBy:ws.username };
    room.queue.push(item);
    broadcastRoom(room, {type:'queue_add',item});
    if(room.playback.currentIndex===-1) {
      const idx = room.queue.length-1;
      room.playback = {currentIndex:idx,isPlaying:true,position:0,startedAt:Date.now()};
      broadcastRoom(room,{type:'playback_update',playback:computePlayback(room)});
      broadcastRoom(room,{type:'chat_system',text:`🎵 Now playing: ${item.title}`});
    }
    return;
  }

  // ── QUEUE REMOVE ─────────────────────────────────────────
  if(type==='queue_remove') {
    const code = wsToRoom.get(ws.wsId);
    if(!code) return;
    const room = rooms.get(code);
    if(!room) return;
    const idx = room.queue.findIndex(i=>i.id===msg.itemId);
    if(idx===-1) return;
    room.queue.splice(idx,1);
    let ci=room.playback.currentIndex;
    if(room.queue.length===0) {
      room.playback={currentIndex:-1,isPlaying:false,position:0,startedAt:null};
    } else {
      if(idx<ci) ci--;
      else if(idx===ci) ci=Math.min(ci,room.queue.length-1);
      room.playback={...computePlayback(room),currentIndex:ci};
      if(room.playback.isPlaying) room.playback.startedAt=Date.now();
    }
    broadcastRoom(room,{type:'queue_remove',itemId:msg.itemId});
    broadcastRoom(room,{type:'playback_update',playback:computePlayback(room)});
    return;
  }

  // ── PLAYBACK CONTROLS ─────────────────────────────────────
  if(type==='play_index') {
    const room=rooms.get(wsToRoom.get(ws.wsId)); if(!room) return;
    const idx=msg.index; if(idx<0||idx>=room.queue.length) return;
    room.trackEndedGuard=-1;
    room.playback={currentIndex:idx,isPlaying:true,position:0,startedAt:Date.now()};
    broadcastRoom(room,{type:'playback_update',playback:computePlayback(room)});
    broadcastRoom(room,{type:'chat_system',text:`🎵 Now playing: ${room.queue[idx].title}`});
    return;
  }

  if(type==='toggle_play') {
    const room=rooms.get(wsToRoom.get(ws.wsId)); if(!room) return;
    const pb=computePlayback(room);
    room.playback=pb.isPlaying?{...pb,isPlaying:false,startedAt:null}:{...pb,isPlaying:true,startedAt:Date.now()};
    broadcastRoom(room,{type:'playback_update',playback:computePlayback(room)});
    return;
  }

  if(type==='seek') {
    const room=rooms.get(wsToRoom.get(ws.wsId)); if(!room) return;
    const pb=computePlayback(room);
    room.playback={...pb,position:msg.position,startedAt:pb.isPlaying?Date.now():null};
    broadcastRoom(room,{type:'playback_update',playback:computePlayback(room)});
    return;
  }

  if(type==='next_track') {
    const room=rooms.get(wsToRoom.get(ws.wsId)); if(!room) return;
    const next=room.playback.currentIndex+1; if(next>=room.queue.length) return;
    room.trackEndedGuard=-1;
    room.playback={currentIndex:next,isPlaying:true,position:0,startedAt:Date.now()};
    broadcastRoom(room,{type:'playback_update',playback:computePlayback(room)});
    broadcastRoom(room,{type:'chat_system',text:`🎵 Now playing: ${room.queue[next].title}`});
    return;
  }

  if(type==='prev_track') {
    const room=rooms.get(wsToRoom.get(ws.wsId)); if(!room) return;
    const prev=room.playback.currentIndex-1;
    if(prev<0) {
      room.playback={...room.playback,position:0,startedAt:room.playback.isPlaying?Date.now():null};
    } else {
      room.playback={currentIndex:prev,isPlaying:true,position:0,startedAt:Date.now()};
      broadcastRoom(room,{type:'chat_system',text:`🎵 Now playing: ${room.queue[prev].title}`});
    }
    broadcastRoom(room,{type:'playback_update',playback:computePlayback(room)});
    return;
  }

  if(type==='track_ended') {
    const room=rooms.get(wsToRoom.get(ws.wsId)); if(!room) return;
    const ci=room.playback.currentIndex;
    if(msg.index!==ci||room.trackEndedGuard===ci) return;
    room.trackEndedGuard=ci;
    const next=ci+1;
    if(next<room.queue.length) {
      room.playback={currentIndex:next,isPlaying:true,position:0,startedAt:Date.now()};
      broadcastRoom(room,{type:'playback_update',playback:computePlayback(room)});
      broadcastRoom(room,{type:'chat_system',text:`🎵 Now playing: ${room.queue[next].title}`});
    } else {
      room.playback={currentIndex:ci,isPlaying:false,position:0,startedAt:null};
      broadcastRoom(room,{type:'playback_update',playback:computePlayback(room)});
      broadcastRoom(room,{type:'chat_system',text:'⏹ Queue finished'});
    }
    return;
  }

  if(type==='chat') {
    const room=rooms.get(wsToRoom.get(ws.wsId)); if(!room) return;
    const text=(msg.text||'').trim().slice(0,300); if(!text) return;
    broadcastRoom(room,{type:'chat',wsId:ws.wsId,username:ws.username,color:rooms.get(wsToRoom.get(ws.wsId))?.members.get(ws.wsId)?.color||COLORS[0],emoji:rooms.get(wsToRoom.get(ws.wsId))?.members.get(ws.wsId)?.emoji||'🦊',text,ts:Date.now()});
    return;
  }

  if(type==='ping') { sendTo(ws,{type:'pong'}); return; }
}

function disconnect(ws) {
  userWs.delete(ws.username);
  wsToSession.delete(ws.wsId);
  const code=wsToRoom.get(ws.wsId); wsToRoom.delete(ws.wsId);
  if(!code) return;
  const room=rooms.get(code); if(!room) return;
  room.members.delete(ws.wsId);
  broadcastRoom(room,{type:'member_left',wsId:ws.wsId});
  if(ws.username) broadcastRoom(room,{type:'chat_system',text:`${ws.username} left`});
}

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`\n🪵  Hearth on http://localhost:${PORT}\n`));
