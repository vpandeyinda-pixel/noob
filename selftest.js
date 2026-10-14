'use strict';

/**
 * Self-test. Run with:  npm run selftest
 *
 * 1. Movement maths (circle, jumping, ground contact, teleports)
 * 2. The movement packet can be encoded/decoded for every Bedrock version the bot may use
 * 3. The cookie handshake Geyser uses (pure-JavaScript fallback network layer)
 * 4. A real local join: a throw-away Bedrock server runs on 127.0.0.1, the bot logs in
 *    (offline), "spawns", and we check the packets it sends.
 *
 * It never contacts your real server and needs no Microsoft account.
 */

const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const os = require('node:os');
const bedrock = require('bedrock-protocol');
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer');
const { Mover } = require('../src/movement');
const { Session, detectInputFormat } = require('../src/bot');
const { chooseBackend, patchPureJsForCookies } = require('../src/raknet');

const VERSIONS = ['1.26.51', '1.26.45', '1.26.40', '1.26.30'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;

function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

function has(inputData, flag) {
  return Array.isArray(inputData) ? inputData.includes(flag) : inputData[flag] === true;
}

function newMover(overrides = {}) {
  return new Mover({
    radius: 3,
    sprint: true,
    jumpEveryMs: 1000,
    startDelayMs: 0,
    inputFormat: 'array',
    ...overrides,
  });
}

// --- 1. movement maths -----------------------------------------------------------

function testMovement() {
  console.log('Movement');
  const mover = newMover();
  mover.setTickBase(0n);
  mover.teleport({ x: 100, y: 64.62, z: -20 }, { onGround: true });

  const packets = [];
  for (let i = 0; i < 400; i += 1) packets.push(mover.step());

  // tick counter goes up by one per packet
  packets.forEach((p, i) => assert.equal(p.tick, BigInt(i + 1)));
  ok('tick counter increases by 1 per packet');

  // first packet acknowledges the teleport and does not move
  assert.ok(has(packets[0].input_data, 'handled_teleport'));
  assert.deepEqual(packets[0].position, { x: 100, y: 64.62, z: -20 });
  assert.equal(packets.filter((p) => has(p.input_data, 'handled_teleport')).length, 1);
  ok('first packet confirms the teleport, position unchanged');

  // circle: x/z span is about two radii and the path never leaves it
  const xs = packets.map((p) => p.position.x);
  const zs = packets.map((p) => p.position.z);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanZ = Math.max(...zs) - Math.min(...zs);
  assert.ok(Math.abs(spanX - 6) < 0.2, `x span ${spanX}`);
  assert.ok(Math.abs(spanZ - 6) < 0.2, `z span ${spanZ}`);
  ok(`runs a circle of radius 3 (span ${spanX.toFixed(2)} x ${spanZ.toFixed(2)})`);

  // speed never exceeds sprint speed (0.2806 blocks/tick) by more than rounding
  let maxStep = 0;
  for (let i = 1; i < packets.length; i += 1) {
    const a = packets[i - 1].position;
    const b = packets[i].position;
    maxStep = Math.max(maxStep, Math.hypot(b.x - a.x, b.z - a.z));
  }
  assert.ok(maxStep <= 0.2806 + 1e-6, `fastest step ${maxStep}`);
  ok(`never faster than sprint speed (max ${maxStep.toFixed(4)} blocks/tick)`);

  // vertical: never below the ground, jump height about vanilla (1.25 blocks), lands again
  const ground = 64.62;
  const ys = packets.map((p) => p.position.y);
  assert.ok(Math.min(...ys) >= ground - 1e-9);
  const height = Math.max(...ys) - ground;
  assert.ok(height > 1.1 && height < 1.35, `jump height ${height}`);
  const jumps = packets.filter((p) => has(p.input_data, 'start_jumping')).length;
  assert.ok(jumps >= 10, `only ${jumps} jumps`);
  ok(`jumps ${jumps}x, peak height ${height.toFixed(2)} blocks, never below the floor`);

  // ground contact flag must match being on the floor (this is what keeps Java from kicking for flying)
  let airborneStreak = 0;
  let longest = 0;
  for (let i = 0; i < packets.length; i += 1) {
    const p = packets[i];
    const onFloor = Math.abs(p.position.y - ground) < 1e-9;
    assert.equal(has(p.input_data, 'vertical_collision'), onFloor, `tick ${i}: collision flag vs floor`);
    if (onFloor) {
      assert.ok(p.delta.y < 0, 'standing on the floor must report negative delta.y');
      airborneStreak = 0;
    } else {
      airborneStreak += 1;
      longest = Math.max(longest, airborneStreak);
    }
  }
  assert.ok(longest <= 14, `airborne for ${longest} ticks`);
  ok(`ground flag matches the floor on every tick (longest jump ${longest} ticks)`);

  // facing: yaw follows the direction of travel
  const p1 = packets[100];
  const p0 = packets[99];
  const dx = p1.position.x - p0.position.x;
  const dz = p1.position.z - p0.position.z;
  const expectedYaw = (-Math.atan2(dx, dz) * 180) / Math.PI;
  assert.ok(Math.abs(((p1.yaw - expectedYaw + 540) % 360) - 180) < 0.01);
  ok('yaw points along the direction of travel');
}

function testTeleports() {
  console.log('Teleports and obstacles');
  const mover = newMover();
  mover.setTickBase(0n);
  mover.teleport({ x: 0, y: 70, z: 0 }, { onGround: true });
  for (let i = 0; i < 30; i += 1) mover.step();

  mover.teleport({ x: 50, y: 80.5, z: 7 }, { onGround: true });
  const after = mover.step();
  assert.ok(has(after.input_data, 'handled_teleport'));
  assert.deepEqual(after.position, { x: 50, y: 80.5, z: 7 });
  const next = mover.step();
  assert.ok(Math.hypot(next.position.x - 50, next.position.z - 7) > 0.05, 'moves again after the confirm tick');
  ok('after a server teleport: confirm in place, then carry on from the new spot');

  const dirBefore = mover.dir;
  for (let i = 0; i < 3; i += 1) {
    mover.teleport({ x: mover.pos.x + 0.3, y: mover.pos.y, z: mover.pos.z }, { onGround: true });
    mover.step();
  }
  assert.equal(mover.dir, -dirBefore);
  assert.ok(mover.radius < 3);
  ok('three corrections in a row = hit something, so it reverses on a smaller circle');
}

// --- 2. packet encoding for every version ---------------------------------------------

function testEncoding() {
  console.log('Packet encoding');
  for (const version of VERSIONS) {
    const format = detectInputFormat(version);
    const serializer = createSerializer(version);
    const deserializer = createDeserializer(version);
    const mover = newMover({ inputFormat: format });
    mover.setTickBase(1234n);
    mover.teleport({ x: 1000.5, y: 64.62, z: -2000.25 }, { onGround: true });

    let sawJump = false;
    let sawGround = false;
    for (let i = 0; i < 120; i += 1) {
      const params = mover.step();
      const buffer = serializer.createPacketBuffer({ name: 'player_auth_input', params });
      const decoded = deserializer.parsePacketBuffer(buffer).data;
      assert.equal(decoded.name, 'player_auth_input');
      const back = decoded.params;
      assert.ok(Math.abs(back.position.x - params.position.x) < 0.01);
      assert.ok(Math.abs(back.position.z - params.position.z) < 0.01);
      assert.equal(BigInt(back.tick), params.tick);
      for (const flag of ['up', 'sprinting', 'vertical_collision', 'start_jumping', 'handled_teleport']) {
        assert.equal(has(back.input_data, flag), has(params.input_data, flag), `${version} flag ${flag} (tick ${i})`);
      }
      sawJump ||= has(back.input_data, 'start_jumping');
      sawGround ||= has(back.input_data, 'vertical_collision');
    }
    assert.ok(sawJump && sawGround);
    ok(`${version}: encodes and decodes correctly (flags as ${format === 'array' ? 'a list' : 'bit flags'})`);
  }
}

// --- 3. real local join ------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

async function testLocalJoin(version, backend, { auto = false } = {}) {
  console.log(`Local join (Bedrock ${version}, ${backend}${auto ? ', version auto-detected' : ''})`);
  const port = await freePort();
  const server = bedrock.createServer({
    host: '127.0.0.1',
    port,
    version,
    offline: true,
    raknetBackend: backend,
    useRaknetWorkers: false,
    maxPlayers: 2,
    conLog: () => {},
  });
  server.on('error', () => {});
  await sleep(600);

  const received = { input: [], actions: [], respawns: [] };
  let serverSide = null;
  server.on('connect', (client) => {
    serverSide = client;
    client.on('error', () => {});
    client.on('join', () => client.write('play_status', { status: 'player_spawn' }));
    client.on('player_auth_input', (p) => received.input.push(p));
    client.on('player_action', (p) => received.actions.push(p));
    client.on('respawn', (p) => received.respawns.push(p));
  });

  const quiet = { debug() {}, info() {}, warn() {}, error: console.error, raw() {} };
  const config = {
    host: '127.0.0.1',
    port,
    username: 'SelfTestBot',
    authMode: 'offline',
    authCacheDir: os.tmpdir(),
    circleRadius: 3,
    sprint: true,
    jumpIntervalMs: 1000,
    startDelayMs: 500,
    connectTimeoutMs: 10000,
    statusEveryMinutes: 10,
    raknetBackend: backend,
  };
  const session = new Session(config, auto ? undefined : version, quiet);
  const finished = session.run();

  // wait for the bot to spawn
  for (let i = 0; i < 100 && !session.outcome.spawned; i += 1) await sleep(100);
  assert.ok(session.outcome.joined, 'bot did not log in');
  assert.ok(session.outcome.spawned, 'bot did not spawn');
  assert.equal(session.client.options.version, version);
  ok(`bot connects, logs in and spawns (Bedrock ${session.client.options.version})`);

  // pretend the server sent start_game (only our own handlers see this fake event)
  const client = session.client;
  client.startGameData.runtime_entity_id = 1n;
  client.emit('start_game', {
    runtime_entity_id: 1n,
    player_position: { x: 100.5, y: 64.62, z: -20.5 },
    rotation: { x: 0, z: 0 },
    current_tick: 500n,
  });

  await sleep(3500);
  const n = received.input.length;
  assert.ok(n >= 40, `server only received ${n} movement packets in 3.5 s`);
  ok(`server receives about 20 movement packets per second (${n} in 3.5 s)`);

  const early = received.input[1];
  assert.ok(Math.abs(early.position.x - 100.5) < 0.01 && Math.abs(early.position.z + 20.5) < 0.01);
  const xs = received.input.slice(-40).map((p) => p.position.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 1, 'bot is not moving');
  ok('bot waits at its spawn point, then starts running');

  const flags = (name) => received.input.some((p) => has(p.input_data, name));
  assert.ok(flags('up') && flags('sprinting') && flags('start_jumping') && flags('vertical_collision'));
  ok('movement packets carry run / sprint / jump / ground flags');

  // server teleports the bot
  const before = received.input.length;
  client.emit('move_player', {
    runtime_id: 1n,
    position: { x: 200, y: 70.62, z: 5 },
    pitch: 0,
    yaw: 90,
    head_yaw: 90,
    mode: 'teleport',
    on_ground: true,
  });
  await sleep(400);
  const confirm = received.input.slice(before).find((p) => has(p.input_data, 'handled_teleport'));
  assert.ok(confirm, 'no teleport confirmation');
  assert.ok(Math.abs(confirm.position.x - 200) < 0.01 && Math.abs(confirm.position.y - 70.62) < 0.01);
  ok('follows a server teleport and confirms it');

  // death and respawn
  client.emit('update_attributes', {
    runtime_entity_id: 1n,
    attributes: [{ name: 'minecraft:health', current: 0, min: 0, max: 20, default: 20, modifiers: [] }],
  });
  await sleep(300);
  assert.ok(received.actions.some((a) => a.action === 'respawn'), 'no respawn request after death');
  client.emit('respawn', { position: { x: 5, y: 70, z: 5 }, state: 1, runtime_entity_id: 1n });
  await sleep(300);
  assert.ok(received.respawns.some((r) => Number(r.state) === 2), 'no client_ready after respawn');
  ok('respawns by itself after dying');

  session.stop('selftest done');
  const outcome = await finished;
  assert.ok(outcome.spawned);
  ok('stops cleanly');

  try {
    serverSide?.close?.();
    server.close();
  } catch {
    /* ignore */
  }
}

// --- 3. cookie handshake (pure-JavaScript fallback) -------------------------------------------

async function testCookieHandshake() {
  console.log('Cookie handshake (as sent by Geyser)');
  patchPureJsForCookies();
  const { Client } = require('jsp-raknet');
  const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
  const COOKIE = Buffer.from('cafebabe', 'hex');

  const port = await freePort();
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(port, '127.0.0.1', resolve));

  const seen = { request1: 0, request2: null };
  socket.on('message', (msg, rinfo) => {
    if (msg[0] === 0x05) {
      seen.request1 += 1;
      // Reply 1: [id][magic][server guid][security=1][cookie][mtu]
      const reply = Buffer.alloc(1 + 16 + 8 + 1 + 4 + 2);
      reply[0] = 0x06;
      MAGIC.copy(reply, 1);
      reply.writeBigInt64BE(42n, 17);
      reply[25] = 1;
      COOKIE.copy(reply, 26);
      reply.writeUInt16BE(1400, 30);
      socket.send(reply, rinfo.port, rinfo.address);
    } else if (msg[0] === 0x07) {
      seen.request2 = msg;
    }
  });

  const client = new Client('127.0.0.1', port);
  client.connect().catch(() => {});
  for (let i = 0; i < 50 && !seen.request2; i += 1) await sleep(100);
  client.close('test over');
  socket.close();

  const r2 = seen.request2;
  assert.ok(r2, 'client never sent Open Connection Request 2');
  assert.deepEqual(r2.subarray(1, 17), MAGIC, 'magic');
  assert.deepEqual(r2.subarray(17, 21), COOKIE, 'cookie must come straight after the magic');
  assert.equal(r2[21], 0, '"client wrote challenge" byte');
  assert.equal(r2[22], 4, 'address: IPv4 marker');
  assert.equal(r2.readUInt16BE(22 + 1 + 4 + 2), 1400, 'MTU after the 7-byte address');
  assert.equal(r2.length, 1 + 16 + 4 + 1 + 7 + 2 + 8, 'total length');
  ok('answers a cookie from the server in the exact layout Geyser expects');
}

// --- run ---------------------------------------------------------------------------------

(async () => {
  const quiet = { debug() {}, info() {}, warn: console.warn, error: console.error, raw() {} };
  const native = chooseBackend('auto', quiet);
  console.log(`(network layer picked automatically: ${native})\n`);

  testMovement();
  testTeleports();
  testEncoding();
  await testCookieHandshake();

  for (const version of VERSIONS) await testLocalJoin(version, native);
  await testLocalJoin(VERSIONS[0], native, { auto: true });
  if (native !== 'jsp-raknet') await testLocalJoin(VERSIONS[0], 'jsp-raknet');

  console.log(`\nAll ${passed} checks passed.`);
  process.exit(0);
})().catch((err) => {
  console.error('\nSELF-TEST FAILED');
  console.error(err);
  process.exit(1);
});
