const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const WebSocket = require('ws');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getFreePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function startServer() {
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 5000);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes(`localhost:${port}`)) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', code => {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}: ${output}`));
      });
    });
  } catch (error) {
    child.kill();
    throw error;
  }

  return { child, port };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, delay(1500)]);
}

function connectPlayer(url, name, room) {
  const socket = new WebSocket(url);
  const messages = [];
  const waiters = new Set();
  const peer = { name, socket, messages };

  socket.on('message', raw => {
    const message = JSON.parse(raw);
    const index = messages.push(message) - 1;
    for (const waiter of [...waiters]) {
      if (index >= waiter.after && waiter.predicate(message)) {
        clearTimeout(waiter.timeout);
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  });

  peer.ready = new Promise((resolve, reject) => {
    socket.once('open', () => {
      socket.send(JSON.stringify({ t: 'join', name, room }));
      resolve();
    });
    socket.once('error', reject);
  });

  peer.waitFor = (predicate, after = 0) => {
    const existingIndex = messages.findIndex((message, index) => index >= after && predicate(message));
    if (existingIndex >= 0) return Promise.resolve(messages[existingIndex]);

    return new Promise((resolve, reject) => {
      const waiter = { predicate, after, resolve, timeout: null };
      waiter.timeout = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out waiting for a message for ${name}`));
      }, 3000);
      waiters.add(waiter);
    });
  };

  return peer;
}

function handTotal(hand) {
  let total = 0, aces = 0;
  for (const card of hand) {
    const rank = card.slice(0, -1);
    if (rank === 'A') { total += 11; aces++; }
    else total += ['J', 'Q', 'K'].includes(rank) ? 10 : Number(rank);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

test('serves Blackjack and enforces multiplayer turns through showdown', async () => {
  const { child, port } = await startServer();
  const peers = [
    connectPlayer(`ws://127.0.0.1:${port}`, 'Player A', 'CI-BLACKJACK'),
    connectPlayer(`ws://127.0.0.1:${port}`, 'Player B', 'CI-BLACKJACK')
  ];

  try {
    const response = await fetch(`http://127.0.0.1:${port}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>Blackjack 21<\/title>/);

    await Promise.all(peers.map(peer => peer.ready));
    const joined = await Promise.all(peers.map(peer => peer.waitFor(state =>
      state.t === 'state' && state.players.length === 2
    )));
    assert.ok(joined.every(state => state.phase === 'waiting'));

    let opening;
    for (let attempt = 0; attempt < 20; attempt++) {
      const cursors = peers.map(peer => peer.messages.length);
      peers[0].socket.send(JSON.stringify({ t: 'start' }));
      opening = await Promise.all(peers.map((peer, index) => peer.waitFor(state =>
        state.t === 'state' && state.ev?.k === 'start', cursors[index]
      )));
      if (opening.every(state => state.phase === 'players' && state.players.every(player => player.status === 'playing'))) break;
    }

    assert.ok(opening.every(state => state.phase === 'players'), 'a playable round should start');
    const firstState = opening[0];
    assert.equal(firstState.dealer.length, 2);
    assert.equal(firstState.dealer[1], null, 'dealer hole card should stay hidden');
    assert.ok(firstState.players.every(player => player.hand.length === 2));
    assert.ok(firstState.players.every(player => player.total === handTotal(player.hand)));

    const firstPlayer = firstState.players[firstState.turn].name;
    const activePeer = peers.find(peer => peer.name === firstPlayer);
    const inactivePeer = peers.find(peer => peer.name !== firstPlayer);
    const messageCounts = peers.map(peer => peer.messages.length);
    inactivePeer.socket.send(JSON.stringify({ t: 'hit' }));
    await delay(100);
    assert.deepEqual(peers.map(peer => peer.messages.length), messageCounts, 'out-of-turn hit should be ignored');

    let cursors = peers.map(peer => peer.messages.length);
    activePeer.socket.send(JSON.stringify({ t: 'stand' }));
    const afterStand = await Promise.all(peers.map((peer, index) => peer.waitFor(state =>
      state.t === 'state' && state.ev?.k === 'stand', cursors[index]
    )));
    const nextTurn = afterStand[0].turn;
    assert.notEqual(afterStand[0].players[nextTurn].name, firstPlayer);
    const nextPeer = peers.find(peer => peer.name === afterStand[0].players[nextTurn].name);

    cursors = peers.map(peer => peer.messages.length);
    nextPeer.socket.send(JSON.stringify({ t: 'hit' }));
    const afterHit = await Promise.all(peers.map((peer, index) => peer.waitFor(state =>
      state.t === 'state' && state.ev?.k === 'hit', cursors[index]
    )));
    const hitPlayer = afterHit[0].players.find(player => player.name === nextPeer.name);
    assert.equal(hitPlayer.hand.length, 3);
    assert.equal(hitPlayer.total, handTotal(hitPlayer.hand));

    let result = afterHit;
    if (afterHit[0].phase === 'players') {
      const standingName = afterHit[0].players[afterHit[0].turn].name;
      const standingPeer = peers.find(peer => peer.name === standingName);
      cursors = peers.map(peer => peer.messages.length);
      standingPeer.socket.send(JSON.stringify({ t: 'stand' }));
      result = await Promise.all(peers.map((peer, index) => peer.waitFor(state =>
        state.t === 'state' && state.ev?.k === 'stand' && state.phase === 'result', cursors[index]
      )));
    }

    assert.ok(result.every(state => state.phase === 'result'));
    const finalState = result[0];
    assert.ok(finalState.dealer.every(Boolean), 'dealer hand should be revealed at showdown');
    assert.ok(finalState.players.every(player => ['ชนะ', 'แพ้', 'เสมอ'].includes(player.result)));
  } finally {
    peers.forEach(peer => peer.socket.close());
    await stopServer(child);
  }
});