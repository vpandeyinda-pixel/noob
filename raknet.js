'use strict';

/**
 * Picks the network ("RakNet") layer bedrock-protocol uses.
 *
 * Why this file exists: Geyser (which Minefort uses for Bedrock) starts every connection with a
 * small "cookie" handshake. The native RakNet library supports it, the pure-JavaScript one that
 * ships with bedrock-protocol does not. So:
 *
 *  1. Use "raknet-native". It bundles a ready-made binary (no compiler needed), but looks for it
 *     in a folder named after the Linux kernel version it was built on ("linux-5-x64"). Most hosts
 *     run a different kernel, so we copy the binary to the place the loader falls back to.
 *  2. If that fails (unusual CPU, missing system library...), use the pure-JavaScript RakNet with a
 *     small patch that adds the cookie handshake.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Make sure raknet-native can be loaded. Returns true when it works. */
function loadNative(log) {
  try {
    require('raknet-native');
    return true;
  } catch (firstError) {
    log.debug(`raknet-native not loadable yet: ${String(firstError.message).split('\n')[0]}`);
  }

  try {
    const root = path.dirname(require.resolve('raknet-native/package.json'));
    const prebuilds = path.join(root, 'prebuilds');
    const folder = fs.readdirSync(prebuilds).find((name) => {
      const [platform, , arch] = name.split('-');
      return platform === process.platform && arch === process.arch;
    });
    if (!folder) {
      log.warn(`No ready-made native RakNet for ${process.platform}/${process.arch}.`);
      return false;
    }
    const target = path.join(root, 'build', 'Release');
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(prebuilds, folder, 'node-raknet.node'), path.join(target, 'node-raknet.node'));
    require('raknet-native');
    log.debug('Loaded the bundled native RakNet binary.');
    return true;
  } catch (err) {
    log.warn(`Could not load the native RakNet: ${String(err.message).split('\n')[0]}`);
    return false;
  }
}

/**
 * Teach the pure-JavaScript RakNet client the cookie handshake.
 *
 *   Reply 1   : [id][magic 16][server guid 8][security 1][cookie 4 if security][mtu 2]
 *   Request 2 : [id][magic 16][cookie 4 + "client wrote challenge" 1 if security][address][mtu 2][guid 8]
 */
function patchPureJsForCookies() {
  const { Client } = require('jsp-raknet');
  if (Client.prototype.cookiePatched) return;
  const Request2 = require('jsp-raknet/js/protocol/OpenConnectionRequest2').default;

  Client.prototype.handleOpenConnectionReply1 = async function handleOpenConnectionReply1(buffer) {
    this.inLog('[raknet] Got OpenConnectionReply1');
    this.state = 1; // connecting
    const security = buffer[25] !== 0;
    const cookie = security ? buffer.subarray(26, 30) : null;
    const mtu = buffer.readUInt16BE(security ? 30 : 26);

    const packet = new Request2();
    packet.mtuSize = Math.min(mtu, 1400);
    packet.clientGUID = this.id;
    packet.serverAddress = this.address;
    packet.encode();
    const out = Buffer.from(packet.buffer);
    if (!security) return out;
    return Buffer.concat([out.subarray(0, 17), cookie, Buffer.from([0]), out.subarray(17)]);
  };
  Client.prototype.cookiePatched = true;
}

/**
 * @param {string} requested "auto" (default), "raknet-native" or "jsp-raknet"
 * @returns {string} the backend name to hand to bedrock-protocol
 */
function chooseBackend(requested, log) {
  const wanted = (requested || 'auto').toLowerCase();

  if (wanted === 'jsp-raknet') {
    patchPureJsForCookies();
    return 'jsp-raknet';
  }

  if (loadNative(log)) return 'raknet-native';

  if (wanted === 'raknet-native') {
    log.warn('RAKNET_BACKEND=raknet-native was requested but it cannot be loaded. Using the pure-JavaScript RakNet instead.');
  } else {
    log.warn('Using the pure-JavaScript RakNet instead of the native one.');
  }
  patchPureJsForCookies();
  return 'jsp-raknet';
}

module.exports = { chooseBackend, loadNative, patchPureJsForCookies };
