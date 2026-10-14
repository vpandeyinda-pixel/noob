# Minecraft Bedrock AFK Bot

A small bot that joins your Bedrock server, **runs in circles and jumps**, and stays connected 24/7 so the
server always has a player online. It reconnects by itself when the server restarts or kicks it.

Pre-set for: `classinpurge.minefort.com` : `19132`

---

## What is in this folder

```
Dockerfile          Railway builds this automatically
package.json        dependencies (bedrock-protocol)
package-lock.json   exact versions, keep it
src/
  index.js          starts everything, reconnects forever
  bot.js            one connection: login, spawn, movement, respawn
  movement.js       the "run in circles + jump" logic
  raknet.js         picks the network layer (Geyser needs the native one)
  config.js         reads the settings (environment variables)
  logger.js         timestamped logs
test/selftest.js    optional: checks everything against a fake local server
.env.example        list of all settings
```

---

## Before you start: the Microsoft login

Minefort handles Bedrock players through **Geyser**, and Geyser only lets in players who are signed in to
Xbox/Microsoft. So the bot needs a Microsoft account (**a spare account is a good idea**).

- The account needs an Xbox gamertag. If it never played Minecraft or used Xbox, sign in once at
  <https://www.xbox.com/> to create one.
- You sign in **once**: the bot prints a code in the Railway logs, you type it on a Microsoft page.
  The login is then saved on a Railway **Volume** (step 4 below), so restarts don't ask again.
- If your server is *not* Geyser-based and has Xbox authentication turned off, you can set
  `AUTH_MODE=offline` and skip all of this.

Also: the bot can only join while the server is running. Start the server from your Minefort dashboard
first. The bot keeps retrying until it gets in.

---

## Deploy: GitHub, then Railway

### 1. Put the files on GitHub
1. Unzip this folder.
2. On GitHub create a **new repository** (private is fine).
3. Upload everything *inside* the unzipped folder (`Dockerfile`, `package.json`, `package-lock.json`,
   `src/`, ...). On the repo page: **Add file → Upload files**, drag it all in, **Commit**.

### 2. Create the Railway service
1. On Railway: **New Project → Deploy from GitHub repo** and pick your repository.
2. Railway finds the `Dockerfile` and builds it. No domain or port is needed because this is a background worker.

### 3. Check the settings (optional)
Everything defaults to your server. To change something, open the service → **Variables** and add it
(see the table below).

### 4. Add a Volume (so you only sign in once)
1. Press **Ctrl/⌘ + K** on the project canvas (or right-click it) and choose **Volume**.
2. Attach it to the bot service, mount path `/data`.
3. Railway redeploys. The bot detects the volume by itself and saves the login there.

### 5. Sign in to Microsoft
1. Open the service → **Deployments → View logs**.
2. Find the box that says **MICROSOFT SIGN-IN NEEDED**. Open the link, type the code, sign in.
3. A few seconds later you should see:
   ```
   Login accepted (Bedrock 1.26.51), waiting to spawn...
   Spawned on classinpurge.minefort.com:19132. Running in circles and jumping...
   ```
   (If the code expired, the bot prints a fresh one.)

### 6. Optional: restart policy
By default Railway restarts a crashed service up to 10 times. The bot reconnects on its own and rarely
exits. On a paid plan you can set **Settings → Deploy → Restart Policy → Always**.

To update the bot later, push changes to GitHub. Railway redeploys automatically.

---

## Settings

All optional. Set them as Railway **Variables**.

| Variable | Default | What it does |
|---|---|---|
| `SERVER_HOST` | `classinpurge.minefort.com` | Server address |
| `SERVER_PORT` | `19132` | Server port |
| `AUTH_MODE` | `microsoft` | `microsoft` (Xbox login) or `offline` (no login) |
| `BOT_USERNAME` | `AFKBot` | Name in offline mode. In Microsoft mode it only labels the saved login, so don't change it after signing in |
| `CIRCLE_RADIUS` | `3` | Size of the circle in blocks (1 to 20) |
| `SPRINT` | `true` | Run (`true`) or walk (`false`) |
| `JUMP_INTERVAL_MS` | `1500` | Time between jumps. `0` = never jump |
| `START_DELAY_MS` | `4000` | Stand still this long after joining before moving |
| `BEDROCK_VERSION` | *(auto)* | Force a Bedrock version, e.g. `1.26.45` |
| `RECONNECT_BASE_MS` | `10000` | First wait before reconnecting (grows up to `RECONNECT_MAX_MS`) |
| `RECONNECT_MAX_MS` | `60000` | Longest wait between reconnect attempts |
| `STATUS_EVERY_MINUTES` | `10` | How often it logs "Still online" |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

---

## Troubleshooting

**"The server did not answer" / "Connect timed out"**: the server is probably asleep or stopped. Start it
from the Minefort dashboard and make sure Bedrock is enabled for it. Check the address and port.

**The sign-in box shows up after every restart**: no Volume is attached (step 4). The bot logs a warning about this at startup.

**"Kicked ... whitelist"**: add the bot's gamertag to the whitelist (the log line `Signed in as "..."` shows it).
On Geyser/Floodgate servers Bedrock names usually start with a dot, like `.Gamertag`.

**"The server did not accept Bedrock x.y.z"**: the bot tries the versions it knows, newest first, by itself.
If all fail, your server is newer than the bot: update the library with
`npm install bedrock-protocol@latest minecraft-data@latest`, then commit `package.json` and `package-lock.json`.

**Kicked for flying / being AFK**: set `JUMP_INTERVAL_MS=0` for the flying case, or a bigger
`CIRCLE_RADIUS` for the AFK case.

**Log says "Bumped into something"**: the bot ran into a wall or tree, so it reverses and uses a smaller circle.
Fix it for good with a smaller `CIRCLE_RADIUS`, or move it in game once so it spawns in open space.

**Xbox errors (gamertag, child account, ...)**: the log explains the cause. Most often the Microsoft account has no gamertag yet.

---

## Good to know

- **Hunger.** In survival mode, sprinting and jumping use up food, so the bot's hunger bar will run out. On
  Easy/Normal difficulty that does not kill it. If you care, use `SPRINT=false` and a bigger `JUMP_INTERVAL_MS`.
  If it dies, it respawns automatically.
- **Host rules.** Some free hosts restrict keep-alive bots. Check your host's rules; that is outside the bot's control.
- **Keep the login private.** The saved Microsoft login lives in the `auth` folder / your Railway Volume.
  It is already in `.gitignore`, so don't upload it to GitHub.
- **Cost.** The bot is tiny, but Railway bills for running time. Check your Railway plan and usage.

## Optional: run the self-test (Node 24 or newer)

```
npm ci --ignore-scripts
npm run selftest
```

It starts a fake Bedrock server on your own computer and checks the login, movement packets, teleports, respawn
and the network layer. It never contacts your real server.
