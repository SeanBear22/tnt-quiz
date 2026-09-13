# Deployment

The app is a single Express process. All game state (players, scores, current
round and question) is held **in memory**, so restarting the process ends any
game in progress. Only the round bank and uploaded images are written to disk.

Because of the in-memory state, this app needs a host that runs a persistent
process with a persistent filesystem. Serverless platforms (Vercel, Netlify)
will not work, and free tiers that sleep on idle or use ephemeral disks will
lose the round bank and uploads on every restart.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port the server listens on. |
| `BANK_FILE` | `./rounds-bank.json` | Path to the saved round library. Point this outside the repo in production so `git pull` cannot overwrite it. |
| `UPLOAD_DIR` | `./uploads` | Where uploaded question/answer images are stored. Also served at `/uploads`. |

Defaults match the original behaviour, so `npm start` locally needs no changes.

## Upload limits

`/api/upload` accepts a single PNG, JPEG, GIF or WebP image up to 5MB.
Anything else is rejected with a `400` and a JSON error message.

## Example: Ubuntu server behind Caddy

Install Node 22 and the app:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git caddy
sudo git clone https://github.com/SeanBear22/tnt-quiz.git /opt/tnt-quiz
cd /opt/tnt-quiz && sudo npm ci --omit=dev
sudo mkdir -p /var/lib/tnt-quiz/uploads
sudo chown -R ubuntu:ubuntu /opt/tnt-quiz /var/lib/tnt-quiz
```

`/etc/systemd/system/tnt-quiz.service`:

```ini
[Unit]
Description=TNT Quiz
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/tnt-quiz
Environment=PORT=3000
Environment=BANK_FILE=/var/lib/tnt-quiz/rounds-bank.json
Environment=UPLOAD_DIR=/var/lib/tnt-quiz/uploads
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tnt-quiz
```

`/etc/caddy/Caddyfile` (Caddy obtains and renews the TLS certificate itself):

```
quiz.example.com {
    reverse_proxy localhost:3000
}
```

Point an A record for the subdomain at the server's public IP. If the DNS is
behind Cloudflare, leave the record unproxied (grey cloud) until the
certificate has been issued.

On Oracle Cloud, ports must be opened in **two** places: an ingress rule for
TCP 80 and 443 in the VCN Security List, and in the instance's own iptables
rules, which by default drop everything except SSH:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## Known limitation: no authentication

There is no authentication anywhere in the app. `/host` is reachable by anyone
with the URL, and every state-changing endpoint (`/api/reveal`, `/api/mark`,
`/api/score/adjust`, `/api/bank/delete`, `/api/upload` and the rest) accepts
unauthenticated requests. Anyone who knows the address can control or disrupt a
running game, or delete the round library.

A reverse proxy can put a password on the host page, which stops casual
interference through the UI:

```
quiz.example.com {
    @host path /host /host.html
    basicauth @host {
        host <bcrypt-hash-from: caddy hash-password>
    }
    reverse_proxy localhost:3000
}
```

This does not protect the API endpoints themselves, which remain callable
directly. Proper protection requires authentication in the application.

## Single game instance

The server holds one game. Two groups cannot play at the same time on one
deployment, and a second host opening `/host` joins the same game rather than
starting a new one.
