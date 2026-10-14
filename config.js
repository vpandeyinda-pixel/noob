'use strict';

const path = require('node:path');

function text(name, fallback) {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : fallback;
}

function number(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number (got "${raw}")`);
  }
  return Math.min(max, Math.max(min, value));
}

function flag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

// When a Railway Volume is attached, Railway sets RAILWAY_VOLUME_MOUNT_PATH.
// We keep the Microsoft login there so it survives restarts and redeploys.
const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const defaultAuthDir = volumePath
  ? path.join(volumePath, 'auth')
  : path.join(process.cwd(), 'auth');

const authMode = text('AUTH_MODE', 'microsoft').toLowerCase();
if (!['microsoft', 'offline'].includes(authMode)) {
  throw new Error(`AUTH_MODE must be "microsoft" or "offline" (got "${authMode}")`);
}

module.exports = {
  // --- Server ---------------------------------------------------------
  host: text('SERVER_HOST', 'serverinpurge.asrv.qzz.io'),
  port: number('SERVER_PORT', 20465, { min: 1, max: 65535 }),

  // --- Login ----------------------------------------------------------
  // "microsoft": real Xbox login (needed for Geyser / Minefort servers).
  // "offline":   no login, only works if the server has Xbox auth disabled.
  authMode,
  // Offline mode: the name shown in game. Microsoft mode: just a cache label.
  username: text('BOT_USERNAME', 'AFKBot'),
  authCacheDir: text('AUTH_CACHE_DIR', defaultAuthDir),

  // Leave empty to auto-pick (newest first, falls back to older ones).
  version: text('BEDROCK_VERSION', ''),

  // --- Behaviour ------------------------------------------------------
  circleRadius: number('CIRCLE_RADIUS', 3, { min: 1, max: 20 }),
  sprint: flag('SPRINT', true),
  // 0 = never jump
  jumpIntervalMs: number('JUMP_INTERVAL_MS', 1500, { min: 0, max: 600000 }),
  // Stand still this long after spawning before starting to run.
  startDelayMs: number('START_DELAY_MS', 4000, { min: 0, max: 60000 }),

  // --- Reconnecting ---------------------------------------------------
  // Keep the base delay at 10s or more: Geyser throttles rapid reconnects.
  reconnectBaseMs: number('RECONNECT_BASE_MS', 10000, { min: 5000, max: 600000 }),
  reconnectMaxMs: number('RECONNECT_MAX_MS', 60000, { min: 5000, max: 3600000 }),
  connectTimeoutMs: number('CONNECT_TIMEOUT_MS', 15000, { min: 3000, max: 120000 }),

  // --- Misc -----------------------------------------------------------
  statusEveryMinutes: number('STATUS_EVERY_MINUTES', 10, { min: 1, max: 1440 }),
  // "auto" = native RakNet if it loads, otherwise the pure-JavaScript one. Rarely needs changing.
  raknetBackend: text('RAKNET_BACKEND', 'auto'),
};
