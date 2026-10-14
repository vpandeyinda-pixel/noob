'use strict';

const fs = require('node:fs');
const bedrock = require('bedrock-protocol');
const minecraftData = require('minecraft-data');
const { Mover, TICK_MS } = require('./movement');

const LOGIN_TIMEOUT_MS = 30_000; // from "login sent" to "server accepted"
const SPAWN_TIMEOUT_MS = 60_000; // from "server accepted" to "spawned in the world"
const ZERO = { x: 0, y: 0, z: 0 };

/** Newer protocol versions send input flags as an array of names, older ones as a bit-flag object. */
function detectInputFormat(version) {
  const types = minecraftData(`bedrock_${version}`).protocol.types;
  const field = types.packet_player_auth_input[1].find((f) => f.name === 'input_data');
  let type = field.type;
  if (Array.isArray(type) && type[0] === 'option') type = type[1]; // some versions wrap it in "option"
  return Array.isArray(type) && type[0] === 'array' ? 'array' : 'bitflags';
}

/** Turn well-known login failures into something a human can act on. */
function explainError(err) {
  const msg = String(err && err.message ? err.message : err);
  const xbox = {
    2148916233: 'This Microsoft account has no Xbox profile (gamertag) yet. Sign in once at https://www.xbox.com/ to create one, then restart the bot.',
    2148916235: 'Xbox Live is not available in the country/region of this Microsoft account.',
    2148916236: 'This Microsoft account needs adult verification before it can use Xbox Live.',
    2148916237: 'This Microsoft account needs adult verification before it can use Xbox Live.',
    2148916238: 'This is a child account. An adult has to add it to a Microsoft Family before it can be used.',
  };
  for (const [code, text] of Object.entries(xbox)) {
    if (msg.includes(code)) return text;
  }
  if (/Unsupported server protocol/i.test(msg)) return 'The server runs a Bedrock version this bot does not know yet. Update the "bedrock-protocol" package (see README).';
  if (/fetch failed/i.test(msg)) return "Could not reach Microsoft's Xbox login servers (network problem). The bot will retry automatically.";
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'Could not look up the server address (DNS). Check SERVER_HOST.';
  if (/timed out/i.test(msg)) return 'The server did not answer. It may be asleep/offline right now (start it from your Minefort dashboard), or the address/port is wrong.';
  return null;
}

/** Hints for common reasons a server removes the bot. */
function explainKick(message) {
  const text = String(message || '');
  if (/whitelist|not (allowed|approved)|allowlist/i.test(text)) {
    return 'The server has a whitelist. Add the bot\'s gamertag (see "Signed in as" above) to it. On Geyser/Floodgate servers Bedrock names start with a dot, e.g. ".Gamertag".';
  }
  if (/fly/i.test(text)) {
    return 'The server\'s anti-cheat thinks the bot is flying. Set JUMP_INTERVAL_MS=0 (no jumping) and/or a smaller CIRCLE_RADIUS, then redeploy.';
  }
  if (/afk|idle|inactiv/i.test(text)) {
    return 'The server kicks idle players. Try a larger CIRCLE_RADIUS (e.g. 5) and SPRINT=true.';
  }
  return null;
}

class Session {
  /**
   * @param {object} config  values from config.js
   * @param {string|undefined} version Bedrock version to connect as (e.g. "1.26.51"), or undefined to
   *                                   let the library ask the server which version it speaks
   * @param {object} log     logger
   */
  constructor(config, version, log) {
    this.config = config;
    this.version = version;
    this.log = log;

    this.client = null;
    this.mover = null;
    this.runtimeId = null;
    this.finished = false;
    this.stopping = false;
    this.resolve = () => {};
    this.timers = new Map();
    this.moveTimer = null;
    this.statusTimer = null;
    this.tickErrors = 0;
    this.lastRespawnRequest = 0;

    this.outcome = {
      version: version || null,
      startedAt: Date.now(),
      joined: false,
      spawned: false,
      spawnedAt: 0,
      kick: null,
      error: null,
      playStatus: null,
    };
  }

  /** Resolves with the outcome once the connection is over (for whatever reason). */
  run() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this._start();
    });
  }

  /** Leave the server politely (used on shutdown). */
  stop(reason = 'Bot is shutting down') {
    if (this.finished) return;
    this.stopping = true;
    try {
      this.client?.disconnect(reason);
    } catch {
      /* ignore */
    }
    this._finish();
  }

  // ---------------------------------------------------------------------------

  _start() {
    const { config, log } = this;
    const offline = config.authMode === 'offline';

    try {
      if (!offline) fs.mkdirSync(config.authCacheDir, { recursive: true });
    } catch (err) {
      log.warn(`Could not create ${config.authCacheDir} (${err.message}). The Microsoft login will not be remembered.`);
    }

    log.info(
      `Connecting to ${config.host}:${config.port} ` +
        `(Bedrock ${this.version || 'version auto-detected'}, ${offline ? 'offline mode' : 'Microsoft login'})...`
    );

    try {
      this.client = bedrock.createClient({
        host: config.host,
        port: config.port,
        username: config.username,
        offline,
        // Without a version the library pings the server first and uses the version it advertises.
        ...(this.version ? { version: this.version } : {}),
        transport: 'raknet',
        // Always connect to exactly the port we were given (some hosts advertise an internal one).
        followPort: false,
        skipPing: false,
        pingTimeout: 3000,
        raknetBackend: config.raknetBackend,
        useRaknetWorkers: false,
        profilesFolder: config.authCacheDir,
        connectTimeout: config.connectTimeoutMs,
        conLog: (message) => {
          // "Server closed connection: undefined" just repeats what we already log.
          if (!/closed connection: undefined/.test(String(message))) log.info(`[network] ${message}`);
        },
        onMsaCode: (code) => this._showMicrosoftCode(code),
      });
    } catch (err) {
      this.outcome.error = err;
      log.error('Could not start the connection:', err);
      this._finish();
      return;
    }

    this._wire(this.client);
  }

  /** The movement controller needs the final Bedrock version (it changes how input flags are encoded). */
  _ensureMover() {
    if (this.mover) return this.mover;
    const { config, log } = this;
    const version = this.client.options.version;
    this.outcome.version = version;
    this.mover = new Mover({
      radius: config.circleRadius,
      sprint: config.sprint,
      jumpEveryMs: config.jumpIntervalMs,
      startDelayMs: config.startDelayMs,
      inputFormat: detectInputFormat(version),
      note: (message) => log.info(message),
    });
    return this.mover;
  }

  _wire(client) {
    const { log } = this;

    client.on('error', (err) => {
      if (!this.outcome.error) this.outcome.error = err;
      const hint = explainError(err);
      const code = err && err.cause && err.cause.code ? ` (${err.cause.code})` : '';
      log.error(`Connection problem: ${err && err.message ? err.message : err}${code}`);
      if (hint) log.error(`  -> ${hint}`);
    });

    client.on('session', (profile) => {
      log.info(`Signed in as "${profile.name}".`);
    });

    client.on('loggingIn', () => {
      this._startTimer('login', LOGIN_TIMEOUT_MS, 'The server did not accept the login in time');
    });

    client.on('join', () => {
      this.outcome.joined = true;
      this._clearTimer('login');
      this._startTimer('spawn', SPAWN_TIMEOUT_MS, 'The bot never finished spawning in the world');
      this.outcome.version = client.options.version;
      log.info(`Login accepted (Bedrock ${client.options.version}), waiting to spawn...`);
    });

    client.on('play_status', (packet) => {
      this.outcome.playStatus = packet.status;
      if (String(packet.status).startsWith('login_failed')) {
        log.warn(`Server refused the login: ${packet.status}`);
      }
    });

    client.on('start_game', (packet) => this._onStartGame(packet));
    client.on('move_player', (packet) => this._onMovePlayer(packet));
    client.on('correct_player_move_prediction', (packet) => this._onCorrection(packet));
    client.on('update_attributes', (packet) => this._onAttributes(packet));
    client.on('respawn', (packet) => this._onRespawn(packet));
    client.on('spawn', () => this._onSpawn());

    client.on('kick', (packet) => {
      this.outcome.kick = String(packet.message ?? '');
      log.warn(`Kicked by the server: ${this.outcome.kick || '(no reason given)'}`);
      const hint = explainKick(this.outcome.kick);
      if (hint) log.warn(`  -> ${hint}`);
    });

    client.on('close', () => this._finish());
  }

  // ---- game events ------------------------------------------------------------

  _onStartGame(packet) {
    const mover = this._ensureMover();
    this.runtimeId = packet.runtime_entity_id;
    mover.setTickBase(packet.current_tick);
    if (packet.player_position) {
      // Geyser sends a placeholder here and the real spot arrives as a teleport a moment later.
      mover.teleport(packet.player_position, {
        yaw: packet.rotation?.z,
        pitch: packet.rotation?.x,
        onGround: true,
      });
    }
  }

  _isMe(id) {
    return this.runtimeId != null && String(id) === String(this.runtimeId);
  }

  _onMovePlayer(packet) {
    if (!this._isMe(packet.runtime_id)) return;
    const mover = this._ensureMover();
    if (packet.mode === 'rotation') {
      if (Number.isFinite(packet.yaw)) mover.yaw = packet.yaw;
      if (Number.isFinite(packet.pitch)) mover.pitch = packet.pitch;
      return;
    }
    mover.teleport(packet.position, {
      yaw: packet.yaw,
      pitch: packet.pitch,
      onGround: packet.on_ground,
    });
  }

  // Bedrock Dedicated Server (server-authoritative movement) corrects us with this packet.
  _onCorrection(packet) {
    if (packet.prediction_type && packet.prediction_type !== 'player') return;
    this._ensureMover().teleport(packet.position, { onGround: packet.on_ground });
  }

  _onAttributes(packet) {
    if (!this._isMe(packet.runtime_entity_id)) return;
    const health = (packet.attributes || []).find((a) => a.name === 'minecraft:health');
    if (health && health.current <= 0) this._requestRespawn();
  }

  _requestRespawn() {
    const now = Date.now();
    if (now - this.lastRespawnRequest < 3000) return;
    this.lastRespawnRequest = now;
    this.log.warn('The bot died. Respawning...');
    this._send('player_action', {
      runtime_entity_id: this.runtimeId,
      action: 'respawn',
      position: ZERO,
      result_position: ZERO,
      face: 0,
    });
  }

  // state: 0 = searching for spawn, 1 = server is ready, 2 = client is ready
  _onRespawn(packet) {
    if (Number(packet.state) !== 1) return;
    if (packet.position) this._ensureMover().teleport(packet.position, { onGround: true });
    this._send('respawn', {
      position: packet.position || ZERO,
      state: 2,
      runtime_entity_id: this.runtimeId,
    });
  }

  _onSpawn() {
    const { config, log } = this;
    this.outcome.spawned = true;
    this.outcome.spawnedAt = Date.now();
    this._clearTimer('spawn');
    this._ensureMover();
    log.info(`Spawned on ${config.host}:${config.port}. Running in circles and jumping...`);

    this.moveTimer = setInterval(() => this._tick(), TICK_MS);
    this.statusTimer = setInterval(() => this._status(), config.statusEveryMinutes * 60_000);
  }

  _tick() {
    if (this.finished) return;
    try {
      this.client.queue('player_auth_input', this.mover.step());
      this.tickErrors = 0;
    } catch (err) {
      this.tickErrors += 1;
      if (this.tickErrors === 1) this.log.error('Could not send a movement packet:', err);
      if (this.tickErrors >= 40) {
        this.outcome.error = err;
        this.log.error('Movement keeps failing, reconnecting.');
        this._finish();
      }
    }
  }

  _status() {
    const minutes = Math.round((Date.now() - this.outcome.spawnedAt) / 60_000);
    const { pos, stats } = this.mover;
    this.log.info(
      `Still online (${minutes} min this session) | position ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)} ` +
        `| jumps ${stats.jumps} | corrections ${stats.corrections}`
    );
  }

  // ---- helpers ------------------------------------------------------------------

  _send(name, params) {
    try {
      this.client.queue(name, params);
    } catch (err) {
      this.log.warn(`Could not send ${name}: ${err.message}`);
    }
  }

  _showMicrosoftCode(code) {
    const userCode = code.user_code || code.userCode;
    const base = code.verification_uri || code.verificationUri || 'https://www.microsoft.com/link';
    const seconds = Number(code.expires_in || code.expiresIn) || 900;
    const minutes = Math.max(1, Math.round(seconds / 60));
    this.log.raw(
      [
        '',
        '================================================================',
        '  MICROSOFT SIGN-IN NEEDED  (one time only)',
        '',
        `  1. Open:       ${base}`,
        `  2. Enter code: ${userCode}`,
        `     (shortcut:  https://www.microsoft.com/link?otc=${userCode})`,
        '  3. Sign in with the Microsoft account the bot should use.',
        '',
        `  The code works for about ${minutes} minutes. If it expires, the bot`,
        '  automatically prints a fresh one.',
        '================================================================',
        '',
      ].join('\n')
    );
  }

  _startTimer(name, ms, message) {
    this._clearTimer(name);
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        if (this.finished) return;
        this.outcome.error = new Error(message);
        this.log.warn(`${message}. Reconnecting...`);
        this._finish();
      }, ms)
    );
  }

  _clearTimer(name) {
    const timer = this.timers.get(name);
    if (timer) clearTimeout(timer);
    this.timers.delete(name);
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    this.outcome.version = this.client?.options?.version ?? this.outcome.version;
    clearInterval(this.moveTimer);
    clearInterval(this.statusTimer);
    for (const name of [...this.timers.keys()]) this._clearTimer(name);
    const client = this.client;
    try {
      client?.close();
    } catch {
      /* already closed */
    }
    // The library removes all listeners when a client closes. Late network errors from this
    // dead connection must not crash the bot (or hit the next connection), so swallow them.
    if (client) setImmediate(() => client.on('error', () => {}));
    this.resolve(this.outcome);
  }
}

module.exports = { Session, explainError, explainKick, detectInputFormat };
