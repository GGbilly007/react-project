const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(d);
  });
});
const wss = new WebSocketServer({ server });
const rooms = {}; // in-memory only, no database

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const newDeck = () => {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
};
function handTotal(hand) {
  let total = 0, aces = 0;
  for (const card of hand) {
    const rank = card.slice(0, -1);
    if (rank === 'A') { total += 11; aces++; }
    else total += ['J', 'Q', 'K'].includes(rank) ? 10 : Number(rank);
  }
  while (total > 21 && aces) { total -= 10; aces--; }
  return total;
}
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

function broadcast(r, ev) {
  r.players.forEach((p, i) => send(p.ws, {
    t: 'state', me: i, code: r.code, phase: r.phase, turn: r.turn,
    dealer: r.phase === 'players' ? [r.dealer[0], null] : r.dealer,
    dealerTotal: r.phase === 'players' ? handTotal([r.dealer[0]]) : handTotal(r.dealer),
    players: r.players.map(x => ({
      name: x.name, hand: x.hand, total: handTotal(x.hand), status: x.status, result: x.result
    })), ev
  }));
}
function settleRound(r) {
  while (handTotal(r.dealer) < 17 && r.deck.length) r.dealer.push(r.deck.pop());
  const dealerTotal = handTotal(r.dealer);
  const dealerBlackjack = r.dealer.length === 2 && dealerTotal === 21;
  for (const p of r.players) {
    const playerTotal = handTotal(p.hand);
    if (p.status === 'bust') p.result = 'แพ้';
    else if (p.status === 'blackjack' && dealerBlackjack) p.result = 'เสมอ';
    else if (p.status === 'blackjack' || dealerTotal > 21 || playerTotal > dealerTotal) p.result = 'ชนะ';
    else if (playerTotal === dealerTotal) p.result = 'เสมอ';
    else p.result = 'แพ้';
  }
  r.phase = 'result';
}
function advanceTurn(r) {
  for (let step = 1; step <= r.players.length; step++) {
    const next = (r.turn + step) % r.players.length;
    if (r.players[next].status === 'playing') { r.turn = next; return; }
  }
  settleRound(r);
}
function startRound(r) {
  r.deck = newDeck();
  r.dealer = [];
  r.players.forEach(p => {
    p.hand = [r.deck.pop(), r.deck.pop()];
    p.status = handTotal(p.hand) === 21 ? 'blackjack' : 'playing';
    p.result = null;
  });
  r.dealer = [r.deck.pop(), r.deck.pop()];
  r.turn = r.players.findIndex(p => p.status === 'playing');
  r.phase = 'players';
  if (r.dealer.length === 2 && handTotal(r.dealer) === 21) {
    r.players.forEach(p => { if (p.status === 'playing') p.status = 'stood'; });
    settleRound(r);
  } else if (r.turn < 0) settleRound(r);
}

wss.on('connection', ws => {
  let room = null, me = null;

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join') {
      const code = String(m.room || '').trim().toUpperCase().slice(0, 12);
      const name = String(m.name || 'Player').trim().slice(0, 14) || 'Player';
      if (!code) return;
      const r = rooms[code] || (rooms[code] = { code, players: [], deck: [], dealer: [], turn: 0, phase: 'waiting' });
      if (r.phase === 'players') return send(ws, { t: 'err', msg: 'รอให้รอบนี้จบก่อนจึงเข้าห้องได้' });
      if (r.players.length >= 4) return send(ws, { t: 'err', msg: 'ห้องเต็ม (สูงสุด 4 คน)' });
      room = r; me = { ws, name, hand: [] };
      r.players.push(me);
      return broadcast(r, { k: 'join', by: r.players.length - 1 });
    }
    if (!room || !me) return;
    const r = room, i = r.players.indexOf(me);

    if (m.t === 'start' && (r.phase === 'waiting' || r.phase === 'result') && r.players.length >= 1) {
      startRound(r);
      return broadcast(r, { k: 'start' });
    }
    if (r.phase !== 'players' || r.players[r.turn] !== me || me.status !== 'playing') return;

    if (m.t === 'hit') {
      if (!r.deck.length) me.status = 'stood';
      else {
        me.hand.push(r.deck.pop());
        me.total = handTotal(me.hand);
        if (me.total > 21) me.status = 'bust';
        else if (me.total === 21) me.status = 'stood';
      }
      const ended = me.status !== 'playing';
      if (ended) advanceTurn(r);
      return broadcast(r, { k: 'hit', by: i, ended });
    }
    if (m.t === 'stand') {
      me.status = 'stood';
      advanceTurn(r);
      return broadcast(r, { k: 'stand', by: i });
    }
  });

  ws.on('close', () => {
    if (!room) return;
    const r = room;
    r.players = r.players.filter(p => p !== me);
    if (!r.players.length) return void delete rooms[r.code];
    if (r.phase === 'players') {
      r.phase = 'waiting';
      r.dealer = [];
      r.players.forEach(p => { p.hand = []; p.status = 'waiting'; p.result = null; });
    }
    r.turn = 0;
    broadcast(r, { k: 'left', name: me.name });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Blackjack 21 running → http://localhost:' + PORT));