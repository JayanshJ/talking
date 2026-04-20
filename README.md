# talking

Group chat with Grok living inside, roasting everyone in Hinglish.

## Features

- Real-time multi-user chat (Socket.IO)
- Grok AI bot in every room — fluent Hinglish, desi gaalis, insult-mode
- Persistent message history (SQLite, WAL)
- Per-room mute toggle (`/mute`, `/unmute`)
- Rate limiting, security headers, compression
- Graceful shutdown, health endpoint, reconnection, invite links
- Mobile-friendly

## Local

```
cp .env.example .env    # paste XAI_API_KEY
npm install
npm start
```

http://localhost:3000 — pick a name + room, share `?room=xxx` with friends.

## Env

| var | default | notes |
|---|---|---|
| `XAI_API_KEY` | — | required for Grok |
| `GROK_MODEL` | `grok-4-latest` | xAI model id |
| `PORT` | `3000` | |
| `DB_PATH` | `./data/talking.db` | SQLite file |
| `TRUST_PROXY` | `0` | set `1` behind Caddy/nginx |
| `NODE_ENV` | `development` | set `production` on server |

## Deploy on Hetzner

On a fresh box (Ubuntu/Debian):

```bash
# 1. deps
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential git caddy

# 2. app
sudo mkdir -p /opt/talking && sudo chown $USER /opt/talking
git clone <repo> /opt/talking && cd /opt/talking
npm ci --omit=dev
cp .env.example .env && vi .env   # XAI_API_KEY, NODE_ENV=production, TRUST_PROXY=1
mkdir -p data
```

### systemd

`/etc/systemd/system/talking.service`:

```ini
[Unit]
Description=talking chat
After=network.target

[Service]
WorkingDirectory=/opt/talking
ExecStart=/usr/bin/node server.js
EnvironmentFile=/opt/talking/.env
Restart=always
RestartSec=3
User=www-data
Group=www-data
# sandbox
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/talking/data
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo chown -R www-data:www-data /opt/talking
sudo systemctl daemon-reload
sudo systemctl enable --now talking
sudo journalctl -u talking -f
```

### Caddy reverse proxy

`/etc/caddy/Caddyfile`:

```
chat.yourdomain.com {
    encode zstd gzip
    reverse_proxy localhost:3000
}
```

Caddy handles TLS + websocket upgrades automatically. `sudo systemctl reload caddy`.

Point the DNS A record for `chat.yourdomain.com` at the Hetzner box and you're live.

### Backups

The DB is `data/talking.db`. Dump hot-safely with:

```bash
sqlite3 /opt/talking/data/talking.db ".backup '/root/talking-$(date +%F).db'"
```

Cron it.

## Commands in chat

- `/mute` — silence Grok in the current room
- `/unmute` — bring him back
- `/help` — show commands
- Any message containing `grok` summons him even when muted
- Short acks (`lol`, `k`, `haha`…) don't trigger him

## Health

`GET /healthz` returns `{ ok: true, uptime: seconds }`.
