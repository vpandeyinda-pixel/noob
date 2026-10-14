'use strict';

const util = require('node:util');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function format(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'string') return arg;
  return util.inspect(arg, { depth: 4, breakLength: 120 });
}

function make(level, write) {
  return (...args) => {
    if (LEVELS[level] < threshold) return;
    write(`[${stamp()}] ${level.toUpperCase().padEnd(5)} ${args.map(format).join(' ')}`);
  };
}

module.exports = {
  debug: make('debug', console.log),
  info: make('info', console.log),
  warn: make('warn', console.warn),
  error: make('error', console.error),
  // Print a block of text exactly as-is (used for the Microsoft sign-in box).
  raw: (text) => console.log(text),
};
