'use strict';
// Human Bingo: zero-dependency Node.js server, anonymous browser sessions and live SSE updates.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST_KEY = process.env.HOST_KEY || '';
const SESSION_SECRET = process.env.SESSION_SECRET || HOST_KEY || crypto.randomBytes(32).toString('hex');
const FILE = path.join(__dirname, 'data.json');
const PAGE = path.join(__dirname, 'public', 'index.html');
const PROMPT_COUNT = 40; // Keep in sync with PROMPTS in public/index.html.
const COOKIE_NAME = 'bingo_sid';
const clients = new Set();
let saveTimer;
let store = Object.create(null);
try {
  const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) store = parsed;
} catch (e) {
  if (e.code !== 'ENOENT') console.error('Could not read saved game data:', e.message);
}

function persist() {
  try {
    const temp = FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(store));
    fs.renameSync(temp, FILE);
  } catch (e) { console.error('Could not save game data:', e.message); }
}
function broadcast() {
  const message = 'data: ' + JSON.stringify(store) + '\n\n';
  for (const res of clients) {
    if (res.destroyed) { clients.delete(res); continue; }
    try { res.write(message); } catch (_) { clients.delete(res); }
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 300);
}
function reply(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}
function fail(res, status, message) { reply(res, status, { error: message }); }
function getCookie(req, name) {
  const hit = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : null;
}
function signature(id) { return crypto.createHmac('sha256', SESSION_SECRET).update(id).digest('hex'); }
function identity(req, res) {
  const cookie = getCookie(req, COOKIE_NAME);
  if (cookie) {
    const parts = cookie.split('.');
    if (parts.length === 2 && /^u[a-f0-9]{32}$/.test(parts[0]) && /^[a-f0-9]{64}$/.test(parts[1])) {
      const expected = Buffer.from(signature(parts[0]), 'hex');
      const received = Buffer.from(parts[1], 'hex');
      if (crypto.timingSafeEqual(expected, received)) return parts[0];
    }
  }
  const id = 'u' + crypto.randomBytes(16).toString('hex');
  const isHttps = Boolean(req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https');
  res.setHeader('Set-Cookie', COOKIE_NAME + '=' + id + '.' + signature(id) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000' + (isHttps ? '; Secure' : ''));
  return id;
}
function isHost(req) {
  return Boolean(HOST_KEY && req.headers['x-host-key'] &&
    Buffer.byteLength(String(req.headers['x-host-key'])) === Buffer.byteLength(HOST_KEY) &&
    crypto.timingSafeEqual(Buffer.from(String(req.headers['x-host-key'])), Buffer.from(HOST_KEY)));
}
function cardItemsValid(items) {
  return Array.isArray(items) && items.length === 25 && items[12] === -1 &&
    items.every((x, i) => i === 12 || (Number.isInteger(x) && x >= 0 && x < PROMPT_COUNT)) &&
    new Set(items.filter((_, i) => i !== 12)).size === 24;
}
function newCard(owner, items) {
  const id = 'c' + crypto.randomBytes(12).toString('hex');
  store['cards/' + id] = { owner, items, marks: { '12': 'free' }, from: null, at: Date.now() };
  return id;
}
function cardsOwnedBy(id) {
  return Object.entries(store).filter(([key, card]) => key.startsWith('cards/') && card.owner === id);
}
const lines = [];
for (let i = 0; i < 5; i++) {
  lines.push(Array.from({ length: 5 }, (_, j) => i * 5 + j));
  lines.push(Array.from({ length: 5 }, (_, j) => j * 5 + i));
}
lines.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);
function hasBingo(card) { return lines.some(line => line.every(i => card.marks && card.marks[i])); }
function doAction(req, res, action, body, userId) {
  const ownPlayer = store['players/' + userId];
  const cardId = body.cardId;
  const cardKey = typeof cardId === 'string' && /^c[a-f0-9]{24}$/.test(cardId) ? 'cards/' + cardId : null;
  const card = cardKey ? store[cardKey] : null;
  if (action === 'host') return reply(res, 200, { ok: isHost(req) });
  if (action === 'join') {
    if (ownPlayer) return fail(res, 409, 'You have already joined this game');
    if (typeof body.name !== 'string' || body.name.length > 20 || !cardItemsValid(body.items)) return fail(res, 400, 'Invalid username or card');
    const name = body.name.trim();
    const handle = name.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '');
    if (!handle) return fail(res, 400, 'Choose a username using English letters or numbers');
    if (Object.entries(store).some(([k, p]) => k.startsWith('players/') && p.handle === handle)) return fail(res, 409, 'Username already taken; choose another');
    store['players/' + userId] = { name, handle, at: Date.now() };
    newCard(userId, body.items);
    broadcast();
    return reply(res, 200, { ok: true });
  }
  if (action === 'reset') {
    if (!isHost(req)) return fail(res, 403, 'Only the host can reset the game');
    for (const [k, v] of Object.entries(store)) {
      if (k.startsWith('cards/')) v.marks = { '12': 'free' };
      if (k.startsWith('claims/')) delete store[k];
    }
    broadcast();
    return reply(res, 200, { ok: true });
  }
  if (!ownPlayer) return fail(res, 403, 'Join the game first');
  if (action === 'new-card') {
    if (!cardItemsValid(body.items)) return fail(res, 400, 'Invalid card');
    const id = newCard(userId, body.items);
    broadcast();
    return reply(res, 200, { ok: true, id });
  }
  if (!card || card.owner !== userId) return fail(res, 403, 'Card does not belong to you');
  if (action === 'mark') {
    const i = body.index, who = body.playerId;
    if (!Number.isInteger(i) || i < 0 || i > 24 || i === 12) return fail(res, 400, 'Invalid square');
    if (who !== null && (typeof who !== 'string' || who === userId || !store['players/' + who])) return fail(res, 400, 'Choose another registered player');
    const marks = { ...card.marks };
    if (who !== null) {
      if (Object.entries(marks).some(([k, v]) => +k !== i && v === who)) return fail(res, 409, 'That player is already used on this card');
      marks[i] = who;
    } else delete marks[i];
    card.marks = marks;
    if (!hasBingo(card)) delete store['claims/' + cardId];
    broadcast();
    return reply(res, 200, { ok: true });
  }
  if (action === 'claim') {
    if (!hasBingo(card)) return fail(res, 409, 'Complete a row, column or diagonal first');
    if (!store['claims/' + cardId]) store['claims/' + cardId] = { owner: userId, at: Date.now() };
    broadcast();
    return reply(res, 200, { ok: true });
  }
  if (action === 'gift') {
    const to = body.to;
    if (typeof to !== 'string' || to === userId || !store['players/' + to]) return fail(res, 400, 'Choose another registered player');
    if (cardsOwnedBy(userId).length < 2) return fail(res, 409, 'You must keep at least one card');
    const pairKey = 'pairs/' + [userId, to].sort().join('_');
    const pair = store[pairKey];
    if (pair && pair.from !== userId) return fail(res, 409, 'Reverse card gifts are not allowed');
    store[pairKey] = { from: userId, to, at: Date.now() };
    card.owner = to;
    card.from = userId;
    card.marks = { '12': 'free' };
    delete store['claims/' + cardId];
    broadcast();
    return reply(res, 200, { ok: true });
  }
  return fail(res, 404, 'Unknown action');
}

http.createServer((req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && pathname === '/') {
    fs.readFile(PAGE, (e, data) => {
      res.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(e ? 'Could not read game page' : data);
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/session') return reply(res, 200, { id: identity(req, res) });
  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('data: ' + JSON.stringify(store) + '\n\n');
    clients.add(res);
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 20000);
    req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
    return;
  }
  if (req.method === 'GET' && pathname === '/health') return reply(res, 200, { ok: true });
  if (req.method === 'POST' && pathname.startsWith('/api/')) {
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return fail(res, 415, 'JSON requests only');
    let body = '', oversize = false;
    req.on('data', chunk => {
      if (oversize) return;
      body += chunk;
      if (body.length > 32768) { oversize = true; fail(res, 413, 'Request too large'); }
    });
    req.on('end', () => {
      if (oversize) return;
      let data;
      try { data = JSON.parse(body || '{}'); } catch (_) { return fail(res, 400, 'Invalid JSON'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(res, 400, 'Invalid JSON body');
      const id = identity(req, res);
      try { doAction(req, res, pathname.slice('/api/'.length), data, id); }
      catch (e) { console.error('API error:', e); fail(res, 500, 'Server error'); }
    });
    return;
  }
  fail(res, 404, 'Not found');
}).listen(PORT, '0.0.0.0', () => {
  console.log('Human Bingo running on port ' + PORT);
  if (!HOST_KEY) console.warn('HOST_KEY is not set: host controls are disabled. Set a strong HOST_KEY before deploying.');
});
process.on('SIGTERM', () => { clearTimeout(saveTimer); persist(); process.exit(0); });
