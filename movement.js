'use strict';

/**
 * Movement for the bot.
 *
 * Every game tick (50 ms) step() returns the parameters of one `player_auth_input`
 * packet. The bot runs around a circle and jumps now and then, using the same
 * numbers a real client uses (vanilla speeds, gravity and jump height), so both
 * Geyser (Java servers) and Bedrock Dedicated Server see believable movement.
 *
 * Things Geyser needs, and why they are here:
 *  - a packet every tick                       -> it forwards one "tick end" to Java per packet
 *  - `vertical_collision` + negative delta.y   -> that is how it decides "on ground" (otherwise
 *                                                 Java kicks for "flying")
 *  - follow server teleports/corrections       -> teleport() re-syncs position and sets the
 *                                                 `handled_teleport` flag
 */

const TICK_MS = 50;

const WALK_SPEED = 0.2158; // blocks per tick (4.317 blocks/s)
const SPRINT_SPEED = 0.2806; // blocks per tick (5.612 blocks/s)
const JUMP_VELOCITY = 0.42;
const GRAVITY = 0.08;
const DRAG = 0.98;
const STANDING_VELOCITY_Y = -0.0784; // what a client reports while standing on the ground
const TWO_PI = Math.PI * 2;
const RAD_TO_DEG = 180 / Math.PI;

const BOUNCE_WINDOW_MS = 3000; // this many corrections inside this window = we hit something
const BOUNCE_COUNT = 3;
const RADIUS_RESTORE_MS = 5 * 60 * 1000;

function normalizeYaw(deg) {
  let yaw = deg % 360;
  if (yaw > 180) yaw -= 360;
  if (yaw <= -180) yaw += 360;
  return yaw;
}

class Mover {
  /**
   * @param {object} o
   * @param {number} o.radius        circle radius in blocks
   * @param {boolean} o.sprint       run faster
   * @param {number} o.jumpEveryMs   0 = never jump
   * @param {number} o.startDelayMs  stand still this long before moving
   * @param {'array'|'bitflags'} o.inputFormat  how this protocol version encodes input flags
   * @param {(message: string) => void} [o.note]
   */
  constructor(o) {
    this.baseRadius = o.radius;
    this.radius = o.radius;
    this.sprint = o.sprint;
    this.jumpEveryTicks = o.jumpEveryMs > 0 ? Math.max(8, Math.round(o.jumpEveryMs / TICK_MS)) : 0;
    this.startDelayTicks = Math.round(o.startDelayMs / TICK_MS);
    this.inputFormat = o.inputFormat;
    this.note = o.note || (() => {});

    this.hasPosition = false;
    this.pos = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;

    // vertical state (we assume flat ground at groundY)
    this.groundY = 0;
    this.vy = STANDING_VELOCITY_Y;
    this.onGround = true;

    // circle state
    this.angle = 0;
    this.dir = 1; // 1 = counter-clockwise, -1 = clockwise
    this.center = { x: 0, z: 0 };

    this.tick = 0n;
    this.ticksAlive = 0;
    this.ticksSinceJump = 0;
    this.jumpHold = 0;
    this.releaseJump = false;
    this.moving = false;
    this.sprintActive = false;
    this.ackTeleport = false;

    this.corrections = [];
    this.lastCorrectionAt = 0;
    this.stats = { jumps: 0, corrections: 0, reversals: 0 };
  }

  setTickBase(value) {
    try {
      this.tick = BigInt(value ?? 0);
    } catch {
      this.tick = 0n;
    }
  }

  _anchorCircle() {
    this.center = {
      x: this.pos.x - this.radius * Math.cos(this.angle),
      z: this.pos.z - this.radius * Math.sin(this.angle),
    };
  }

  /**
   * The server told us where we are (spawn, /tp, rubber-band, respawn...).
   * @param {{x:number,y:number,z:number}} pos
   * @param {{yaw?:number, pitch?:number, onGround?:boolean}} [opts]
   */
  teleport(pos, opts = {}) {
    const now = Date.now();
    const distance = this.hasPosition
      ? Math.hypot(pos.x - this.pos.x, pos.y - this.pos.y, pos.z - this.pos.z)
      : Infinity;
    const isCorrection = this.moving && this.hasPosition;

    this.hasPosition = true;
    this.pos = { x: pos.x, y: pos.y, z: pos.z };
    if (typeof opts.yaw === 'number' && Number.isFinite(opts.yaw)) this.yaw = normalizeYaw(opts.yaw);
    if (typeof opts.pitch === 'number' && Number.isFinite(opts.pitch)) this.pitch = opts.pitch;

    // Far away (or told we're standing)? Assume we stand on the ground at the new spot.
    if (distance > 1.5 || opts.onGround) {
      this.groundY = pos.y;
      this.onGround = true;
      this.vy = STANDING_VELOCITY_Y;
      this.jumpHold = 0;
      this.releaseJump = false;
    }

    if (isCorrection) {
      this.stats.corrections += 1;
      this.lastCorrectionAt = now;
      this.corrections = this.corrections.filter((t) => now - t < BOUNCE_WINDOW_MS);
      this.corrections.push(now);
      if (this.corrections.length >= BOUNCE_COUNT) {
        // Something is in the way: go the other direction on a smaller circle.
        this.dir = -this.dir;
        this.radius = Math.max(1.5, this.radius * 0.75);
        this.corrections = [];
        this.stats.reversals += 1;
        this.note(`Bumped into something, reversing direction (circle radius ${this.radius.toFixed(1)})`);
      }
    }

    this._anchorCircle();
    this.ackTeleport = true;
  }

  _flagsToInput(flags) {
    if (this.inputFormat === 'array') return Array.from(flags);
    const out = {};
    for (const name of flags) out[name] = true;
    return out;
  }

  /** Build the next tick. */
  step() {
    const now = Date.now();
    this.tick += 1n;
    this.ticksAlive += 1;
    this.ticksSinceJump += 1;

    const flags = new Set();
    this.moving = this.hasPosition && this.ticksAlive > this.startDelayTicks;

    // Right after a server teleport a real client just reports "I'm here" (flag
    // handled_teleport) and does not move that tick. Geyser waits for exactly that.
    const justTeleported = this.ackTeleport;
    this.ackTeleport = false;
    if (justTeleported) flags.add('handled_teleport');

    // Slowly go back to the configured radius once nothing has bumped us for a while.
    if (this.radius !== this.baseRadius && now - this.lastCorrectionAt > RADIUS_RESTORE_MS) {
      this.radius = this.baseRadius;
      this._anchorCircle();
    }

    // ---- horizontal: run around the circle ---------------------------------
    let vx = 0;
    let vz = 0;
    if (this.moving && !justTeleported) {
      const speed = this.sprint ? SPRINT_SPEED : WALK_SPEED;
      this.angle = (this.angle + (this.dir * speed) / this.radius) % TWO_PI;
      const nx = this.center.x + this.radius * Math.cos(this.angle);
      const nz = this.center.z + this.radius * Math.sin(this.angle);
      vx = nx - this.pos.x;
      vz = nz - this.pos.z;
      this.pos.x = nx;
      this.pos.z = nz;
      // Minecraft yaw: 0 = +Z, 90 = -X. Face the way we are running.
      this.yaw = normalizeYaw(-Math.atan2(vx, vz) * RAD_TO_DEG);

      flags.add('up');
      if (this.sprint) {
        flags.add('sprint_down');
        flags.add('sprinting');
        if (!this.sprintActive) {
          flags.add('start_sprinting');
          this.sprintActive = true;
        }
      }
    } else if (this.sprintActive && !this.moving) {
      flags.add('stop_sprinting');
      this.sprintActive = false;
    }

    // ---- vertical: jump now and then, vanilla gravity -----------------------
    let startedJump = false;
    if (
      this.moving &&
      !justTeleported &&
      this.jumpEveryTicks > 0 &&
      this.onGround &&
      this.ticksSinceJump >= this.jumpEveryTicks
    ) {
      startedJump = true;
      this.onGround = false;
      this.vy = JUMP_VELOCITY;
      this.ticksSinceJump = 0;
      this.jumpHold = 2; // key held for 2 ticks, like a quick tap
      this.stats.jumps += 1;
    }

    if (justTeleported) {
      if (this.onGround) this.vy = STANDING_VELOCITY_Y;
    } else if (!this.onGround) {
      this.pos.y += this.vy;
      this.vy = (this.vy - GRAVITY) * DRAG;
      if (this.vy < 0 && this.pos.y <= this.groundY) {
        this.pos.y = this.groundY;
        this.onGround = true;
        this.vy = STANDING_VELOCITY_Y;
      }
    } else {
      this.vy = STANDING_VELOCITY_Y;
    }

    // Standing on / landing on the ground: Geyser reads this to tell Java "onGround".
    if (this.onGround) flags.add('vertical_collision');

    if (startedJump) {
      flags.add('start_jumping');
      flags.add('jump_pressed_raw');
    }
    if (this.jumpHold > 0) {
      flags.add('jump_down');
      flags.add('jumping');
      flags.add('jump_current_raw');
      this.jumpHold -= 1;
      if (this.jumpHold === 0) this.releaseJump = true;
    } else if (this.releaseJump) {
      flags.add('jump_released_raw');
      this.releaseJump = false;
    }

    // ---- assemble the packet ----------------------------------------------------
    const forward = this.moving && !justTeleported ? 1 : 0;
    const yawRad = this.yaw / RAD_TO_DEG;
    const pitchRad = this.pitch / RAD_TO_DEG;

    return {
      pitch: this.pitch,
      yaw: this.yaw,
      position: { x: this.pos.x, y: this.pos.y, z: this.pos.z },
      move_vector: { x: 0, z: forward },
      head_yaw: this.yaw,
      input_data: this._flagsToInput(flags),
      input_mode: 'mouse',
      play_mode: 'normal',
      interaction_model: 'crosshair',
      interact_rotation: { x: this.pitch, z: this.yaw },
      tick: this.tick,
      delta: { x: vx, y: this.vy, z: vz },
      transaction: undefined,
      item_stack_request: undefined,
      block_action: undefined,
      vehicle_rotation: undefined,
      predicted_vehicle: undefined,
      analogue_move_vector: { x: 0, z: forward },
      camera_orientation: {
        x: -Math.sin(yawRad) * Math.cos(pitchRad),
        y: -Math.sin(pitchRad),
        z: Math.cos(yawRad) * Math.cos(pitchRad),
      },
      raw_move_vector: { x: 0, z: forward },
    };
  }
}

module.exports = { Mover, TICK_MS };
