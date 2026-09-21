/**
 * BLOCK WARFARE — Real-time multiplayer server
 * Created by Shayan
 *
 * Run:   npm install
 *        node server.js
 * Then in the game's "PLAY ONLINE" screen, enter:
 *   ws://<this-machine's-LAN-IP>:8080      (same WiFi, e.g. phones + laptop)
 *   wss://your-deployed-domain              (if hosted publicly with TLS)
 *
 * Protocol is plain JSON over WebSocket. See BLOCK_WARFARE_HOSTING.md for details.
 */
'use strict';
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// ---- weapon table mirrored from the client (used only to validate/clamp damage) ----
const WEAPONS = {
  assault: { dmg: 24, fireRate: 9,  pellets: 1 },
  smg:     { dmg: 16, fireRate: 14, pellets: 1 },
  shotgun: { dmg: 9,  fireRate: 1.2, pellets: 7 },
  sniper:  { dmg: 95, fireRate: 0.9, pellets: 1 },
  pistol:  { dmg: 20, fireRate: 5,  pellets: 1 },
  lmg:     { dmg: 20, fireRate: 11, pellets: 1 },
};
const WEAPON_IDS = Object.keys(WEAPONS);
const MAX_PLAYERS_PER_ROOM = 4;
const WIN_SCORE = 10;
const RESPAWN_MS = 3200;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('BLOCK WARFARE server is running. Connect with a WebSocket client.\n');
});
const wss = new WebSocket.Server({ server });

/** @type {Map<string, Room>} */
const rooms = new Map();
let nextPlayerId = 1;

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }
}
function broadcastRoom(room, obj, exceptId) {
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    send(p.ws, obj);
  }
}
function publicPlayers(room) {
  return Array.from(room.players.values()).map(p => ({
    id: p.id, name: p.name, team: p.team, ready: p.ready,
    isLeader: p.id === room.leaderId, charId: p.charId, connected: true,
  }));
}
function sendRoomUpdate(room) {
  broadcastRoom(room, {
    type: 'room_update', players: publicPlayers(room),
    leaderId: room.leaderId, map: room.map, mode: room.mode,
  }, null);
}
function removePlayerFromRoom(player, notify) {
  const room = rooms.get(player.roomCode);
  if (!room) return;
  room.players.delete(player.id);
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.leaderId === player.id) {
    room.leaderId = room.players.values().next().value.id; // promote next player
  }
  if (notify) broadcastRoom(room, { type: 'player_left', id: player.id, name: player.name }, null);
  sendRoomUpdate(room);
  // if a match is running and a team is now empty, end it gracefully
  if (room.match && room.match.active) {
    const teams = new Set(Array.from(room.players.values()).map(p => p.team));
    if (teams.size < 2) {
      room.match.active = false;
      const remainingTeam = Array.from(room.players.values())[0] ? Array.from(room.players.values())[0].team : 1;
      broadcastRoom(room, { type: 'match_end', winningTeam: remainingTeam }, null);
    }
  }
}

function createRoom(ws, name, charId) {
  const code = genCode();
  const id = 'p' + (nextPlayerId++);
  const player = { id, ws, name: (name || 'Player').slice(0, 14), charId: charId || 'c1',
    team: 1, ready: false, roomCode: code, weaponId: 'assault', hp: 100, alive: true,
    dmgBudget: 0, lastBudgetTime: Date.now() };
  const room = { code, players: new Map([[id, player]]), leaderId: id, map: 'city', mode: 'tdm', match: null };
  rooms.set(code, room);
  ws.playerId = id; ws.roomCode = code;
  send(ws, { type: 'room_created', code, yourId: id, leaderId: room.leaderId, players: publicPlayers(room), map: room.map, mode: room.mode });
}
function joinRoom(ws, code, name, charId) {
  const room = rooms.get(code);
  if (!room) { send(ws, { type: 'error', message: 'Room not found' }); return; }
  if (room.players.size >= MAX_PLAYERS_PER_ROOM) { send(ws, { type: 'error', message: 'Room is full' }); return; }
  const id = 'p' + (nextPlayerId++);
  // balance new player onto the smaller team
  let t1 = 0, t2 = 0;
  room.players.forEach(p => { if (p.team === 1) t1++; else t2++; });
  const team = t1 <= t2 ? 1 : 2;
  const player = { id, ws, name: (name || 'Player').slice(0, 14), charId: charId || 'c1',
    team, ready: false, roomCode: code, weaponId: 'assault', hp: 100, alive: true,
    dmgBudget: 0, lastBudgetTime: Date.now() };
  room.players.set(id, player);
  ws.playerId = id; ws.roomCode = code;
  send(ws, { type: 'joined', code, yourId: id, leaderId: room.leaderId, players: publicPlayers(room), map: room.map, mode: room.mode });
  sendRoomUpdate(room);
}

function applyHitBudget(shooter, weaponId, requestedDamage, headshot) {
  const wt = WEAPONS[WEAPON_IDS.includes(weaponId) ? weaponId : 'assault'];
  const now = Date.now();
  const dps = wt.dmg * wt.fireRate * wt.pellets;
  const elapsed = Math.max(0, (now - (shooter.lastBudgetTime || now)) / 1000);
  shooter.lastBudgetTime = now;
  shooter.dmgBudget = Math.min(dps * 1.5, (shooter.dmgBudget || 0) + dps * elapsed);
  const maxSingle = wt.dmg * (headshot ? 1.9 : 1.15);
  let dmg = Math.min(Number(requestedDamage) || 0, maxSingle);
  if (dmg > shooter.dmgBudget) dmg = shooter.dmgBudget;
  if (dmg < 0) dmg = 0;
  shooter.dmgBudget -= dmg;
  return dmg;
}

function startMatch(room, leader) {
  const players = Array.from(room.players.values());
  const teams = new Set(players.map(p => p.team));
  if (players.length < 2 || teams.size < 2) {
    send(leader.ws, { type: 'error', message: 'Need players on both teams to start' });
    return;
  }
  const notReady = players.filter(p => p.id !== room.leaderId && !p.ready);
  if (notReady.length > 0) {
    send(leader.ws, { type: 'error', message: 'Waiting for all players to be ready' });
    return;
  }
  players.forEach(p => { p.hp = 100; p.alive = true; p.weaponId = 'assault'; p.dmgBudget = 0; p.lastBudgetTime = Date.now(); });
  room.match = { active: true, score1: 0, score2: 0 };
  broadcastRoom(room, {
    type: 'match_start', map: room.map, mode: room.mode,
    players: players.map(p => ({ id: p.id, name: p.name, team: p.team, charId: p.charId, weaponId: p.weaponId })),
  }, null);
}

function handleHit(room, shooter, msg) {
  if (!room.match || !room.match.active) return;
  const target = room.players.get(msg.targetId);
  if (!target || !target.alive || !shooter.alive) return;
  if (target.team === shooter.team) return; // no friendly fire
  const dmg = applyHitBudget(shooter, msg.weaponId, msg.damage, !!msg.headshot);
  if (dmg <= 0) return;
  target.hp = Math.max(0, target.hp - dmg);
  broadcastRoom(room, { type: 'damage', targetId: target.id, sourceId: shooter.id, hp: target.hp, headshot: !!msg.headshot }, null);
  if (target.hp <= 0) {
    target.alive = false;
    if (shooter.team === 1) room.match.score1++; else room.match.score2++;
    const newWeaponId = WEAPON_IDS[Math.floor(Math.random() * WEAPON_IDS.length)];
    shooter.weaponId = newWeaponId;
    broadcastRoom(room, {
      type: 'eliminated', targetId: target.id, sourceId: shooter.id, newWeaponId,
      sourceName: shooter.name, targetName: target.name,
    }, null);
    broadcastRoom(room, { type: 'score_update', score1: room.match.score1, score2: room.match.score2 }, null);
    if (room.match.score1 >= WIN_SCORE || room.match.score2 >= WIN_SCORE) {
      room.match.active = false;
      broadcastRoom(room, { type: 'match_end', winningTeam: room.match.score1 > room.match.score2 ? 1 : 2 }, null);
      return;
    }
    setTimeout(() => {
      if (!room.players.has(target.id)) return;
      target.hp = 100; target.alive = true;
      broadcastRoom(room, { type: 'respawn', id: target.id }, null);
    }, RESPAWN_MS);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'create_room') {
      if (ws.roomCode) removePlayerFromRoom({ id: ws.playerId, roomCode: ws.roomCode }, true);
      createRoom(ws, msg.name, msg.charId);
      return;
    }
    if (msg.type === 'join_room') {
      if (ws.roomCode) removePlayerFromRoom({ id: ws.playerId, roomCode: ws.roomCode }, true);
      joinRoom(ws, String(msg.code || '').toUpperCase(), msg.name, msg.charId);
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const player = room.players.get(ws.playerId);
    if (!player) return;

    switch (msg.type) {
      case 'set_team':
        if (msg.team === 1 || msg.team === 2) { player.team = msg.team; sendRoomUpdate(room); }
        break;
      case 'set_ready':
        player.ready = !!msg.ready; sendRoomUpdate(room);
        break;
      case 'set_map':
        if (player.id === room.leaderId) { room.map = String(msg.map || room.map); sendRoomUpdate(room); }
        break;
      case 'set_mode':
        if (player.id === room.leaderId) { room.mode = (msg.mode === 'br' ? 'br' : 'tdm'); sendRoomUpdate(room); }
        break;
      case 'start_match':
        if (player.id === room.leaderId) startMatch(room, player);
        break;
      case 'state':
        if (room.match && room.match.active && player.alive && Array.isArray(msg.pos) && msg.pos.length === 3) {
          broadcastRoom(room, { type: 'state', id: player.id, pos: msg.pos, yaw: Number(msg.yaw) || 0 }, player.id);
        }
        break;
      case 'shoot':
        if (room.match && room.match.active && Array.isArray(msg.o) && Array.isArray(msg.d)) {
          broadcastRoom(room, { type: 'shoot', id: player.id, o: msg.o, d: msg.d }, player.id);
        }
        break;
      case 'hit':
        handleHit(room, player, msg);
        break;
      case 'chat': {
        const text = String(msg.msg || '').slice(0, 80);
        if (text) broadcastRoom(room, { type: 'chat', id: player.id, name: player.name, msg: text }, null);
        break;
      }
      case 'leave_room':
        removePlayerFromRoom(player, true);
        ws.roomCode = null; ws.playerId = null;
        break;
    }
  });

  ws.on('close', () => {
    if (ws.roomCode && ws.playerId) {
      const room = rooms.get(ws.roomCode);
      const player = room && room.players.get(ws.playerId);
      if (player) removePlayerFromRoom(player, true);
    }
  });
  ws.on('error', () => {});
});

// drop dead connections
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 15000);
wss.on('close', () => clearInterval(pingInterval));

server.listen(PORT, () => {
  console.log('BLOCK WARFARE server listening on port ' + PORT);
});
