'use strict';

const log = require('./logger');

let config;
try {
  config = require('./config');
} catch (err) {
  log.error(`Configuration problem: ${err.message}`);
  process.exit(1);
}

const { Session } = require('./bot');
const { chooseBackend } = require('./raknet');

// Newest first. If a server says our version is too new we step down this list.
const VERSION_ORDER = ['1.26.51', '1.26.45', '1.26.40', '1.26.30'];
const STABLE_AFTER_MS = 60_000; // a session this long counts as "worked fine"

let shuttingDown = false;
let current = null;
let wakeUp = null;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wakeUp = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function backoff(failures) {
  const exponent = Math.max(0, failures - 1);
  const delay = Math.min(config.reconnectMaxMs, config.reconnectBaseMs * 1.5 ** exponent);
  return Math.round(delay + delay * 0.1 * Math.random());
}

/** Did the server turn us away because of the Bedrock version? */
function versionProblem(outcome) {
  if (outcome.joined) return null;
  if (outcome.playStatus === 'login_failed_server_old') return 'bot-too-new';
  if (outcome.playStatus === 'login_failed_client_old') return 'bot-too-old';
  const text = String(outcome.kick || '');
  if (/outdated|not (yet )?compatible|incompatible|unsupported|supported version|please (use|update|upgrade)|protocol/i.test(text)) {
    return 'unknown';
  }
  return null;
}

function banner() {
  log.info('------------------------------------------------------------');
  log.info(' Minecraft Bedrock AFK bot');
  log.info(` Server : ${config.host}:${config.port}`);
  log.info(` Login  : ${config.authMode === 'offline' ? `offline, name "${config.username}"` : 'Microsoft account'}`);
  log.info(` Version: ${config.version || 'auto-detected from the server'}`);
  log.info(` Network: ${config.raknetBackend}`);
  log.info(` Moves  : circle radius ${config.circleRadius}, ${config.sprint ? 'sprinting' : 'walking'}, ` +
    `${config.jumpIntervalMs > 0 ? `jump every ${config.jumpIntervalMs} ms` : 'no jumping'}`);
  log.info('------------------------------------------------------------');

  const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT);
  if (config.authMode === 'microsoft' && onRailway && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.AUTH_CACHE_DIR) {
    log.warn('No Railway Volume is attached, so the Microsoft login is forgotten whenever the bot restarts.');
    log.warn('Add a Volume to this service (any mount path, e.g. /data) and redeploy. See the README.');
  }
}

async function main() {
  config.raknetBackend = chooseBackend(config.raknetBackend, log);
  banner();

  let forcedVersion = null; // only set when the server turned us away because of our version
  let failures = 0;

  while (!shuttingDown) {
    const requested = config.version || forcedVersion || undefined;
    current = new Session(config, requested, log);
    const outcome = await current.run();
    current = null;
    if (shuttingDown) break;

    const stable = outcome.spawned && Date.now() - outcome.spawnedAt >= STABLE_AFTER_MS;
    failures = stable ? 0 : failures + 1;

    if (!config.version) {
      const problem = versionProblem(outcome);
      if (problem === 'bot-too-old') {
        log.error('The server is newer than this bot supports. Update the "bedrock-protocol" package (see README).');
      } else if (problem) {
        // Step down to the next older version than the one we just tried.
        const used = outcome.version;
        const next = VERSION_ORDER[VERSION_ORDER.indexOf(used) + 1];
        forcedVersion = next || null; // ran out of versions: go back to auto-detect
        log.warn(`The server did not accept Bedrock ${used}. ${next ? `Trying ${next} next.` : 'Going back to auto-detect.'}`);
      }
    }

    const delay = backoff(failures);
    log.info(`Disconnected. Reconnecting in ${Math.round(delay / 1000)} s...`);
    await sleep(delay);
  }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}. Leaving the server and shutting down...`);
  if (current) current.stop('Bot is shutting down');
  if (wakeUp) wakeUp();
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// A 24/7 bot should survive odd network errors: log them and reconnect instead of dying.
process.on('uncaughtException', (err) => {
  log.error('Unexpected error:', err);
  if (current) current.stop('Unexpected error');
});
process.on('unhandledRejection', (reason) => {
  log.error('Unexpected error (promise):', reason);
  if (current) current.stop('Unexpected error');
});

main().catch((err) => {
  log.error('Fatal error:', err);
  process.exit(1);
});
