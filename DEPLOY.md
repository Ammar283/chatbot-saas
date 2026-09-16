# Deploying

The one requirement that rules out most free tiers: **`data/` must survive a
restart.** It holds every client's leads, knowledge and login. Platforms with
ephemeral disks will silently erase it on each deploy.

## Option A — Railway (start here)

Easiest path, about 15 minutes.

1. Push this folder to a private GitHub repo. Check `.env` is **not** in it.
2. railway.app → New Project → Deploy from GitHub repo.
3. **Add a Volume**, mount path `/data`. This step is not optional.
4. Variables → paste everything from your `.env`, plus:
   ```
   DATA_DIR=/data
   NODE_ENV=production
   ```
5. Settings → Generate Domain. That address is your dashboard.

Roughly $5/month. Cost scales with usage, not clients.

## Option B — A small VPS (once you have paying clients)

Hetzner, DigitalOcean or Contabo, €4–6/month, and nothing can rug-pull you.

```bash
# on the server
apt update && apt install -y nodejs npm caddy
git clone YOUR_REPO /opt/chatbot && cd /opt/chatbot
npm ci --omit=dev
cp .env.example .env && nano .env      # fill it in

# keep it running
npm i -g pm2
pm2 start server.js --name chatbot
pm2 save && pm2 startup
```

TLS in one line — put this in `/etc/caddy/Caddyfile`, then `systemctl reload caddy`:

```
chat.yourdomain.com {
  reverse_proxy localhost:3000
}
```

Nightly off-server backup:

```bash
crontab -e
0 3 * * * cd /opt/chatbot && /usr/bin/node scripts/backup.js --upload >> /var/log/chatbot-backup.log 2>&1
```

## Option C — Docker

A `Dockerfile` is included. Works on Fly.io, Render (paid tier with a disk),
Coolify, or your own box.

```bash
docker build -t chatbot .
docker run -d --env-file .env -v chatbot-data:/data -p 3000:3000 chatbot
```

## Before you point a client at it

- [ ] `NODE_ENV=production` — session cookies become HTTPS-only
- [ ] `SESSION_SECRET` set to something long and random
- [ ] `ADMIN_KEY` and `OWNER_PASSWORD` changed from anything you pasted in chat
- [ ] Volume mounted and `DATA_DIR` pointing at it
- [ ] `.env` not in git
- [ ] Ran `npm run backup` once and confirmed a file appears
- [ ] `OPERATOR_EMAIL` set, so you hear about outages before the client does
- [ ] Allowed website addresses set per workspace, so the key can't be lifted

## Paying for it from Pakistan

Railway, Hetzner and DigitalOcean all need an international card. A Payoneer or
Wise card works where a local debit card usually will not. Worth sorting before
you are mid-deploy at midnight.
