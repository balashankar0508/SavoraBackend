# Savora Backend

Self-hosted Node.js/TypeScript API for Savora, replacing Supabase (Postgres + Auth + Edge Functions). Raw `pg` (no ORM), JWT + bcrypt auth, deployed bare-metal on a VPS via PM2 + Nginx + Postgres, no Docker.

## Local development

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT secrets, GEMINI_API_KEY, RESEND_API_KEY, MAIL_FROM
npm run migrate         # applies migrations/*.sql against DATABASE_URL
npm run dev             # ts-node-dev, restarts on file changes
```

Generate strong secrets for `.env`:
```bash
openssl rand -hex 32   # JWT_ACCESS_SECRET
openssl rand -hex 32   # JWT_REFRESH_PEPPER
```

## Smoke testing

```bash
API=http://localhost:4000 ./scripts/smoke-test.sh
# read the OTP code from your Resend dashboard / logs, then:
CODE=123456 EMAIL=<from previous output> API=http://localhost:4000 ./scripts/smoke-test-verify.sh
```

## VPS provisioning (Ubuntu 22.04/24.04, 1-2 vCPU / 2-4GB — e.g. Hetzner CX22, DigitalOcean, Contabo)

```bash
# 1. Non-root user
adduser savora && usermod -aG sudo savora
# su - savora, do everything below as this user

# 2. Firewall
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# 3. fail2ban (sshd hardening)
sudo apt update && sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban

# 4. Node.js LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 5. Postgres (native)
sudo apt install -y postgresql postgresql-contrib
sudo -u postgres psql -c "CREATE ROLE savora_app WITH LOGIN PASSWORD 'STRONG_RANDOM_PW';"
sudo -u postgres psql -c "CREATE DATABASE savora OWNER savora_app;"
# Edit /etc/postgresql/*/main/pg_hba.conf: use scram-sha-256, keep it localhost-only
# (the Node app runs on the same box and connects via 127.0.0.1 — no need to expose 5432 externally)
sudo systemctl restart postgresql

# 6. Nginx + TLS
sudo apt install -y nginx certbot python3-certbot-nginx
# create /etc/nginx/sites-available/savora-api (see below), symlink into sites-enabled, then:
sudo certbot --nginx -d api.yourdomain.com

# 7. PM2
sudo npm install -g pm2
cd ~/SavoraBackend
npm ci               # full install — tsc/ts-node (devDependencies) are needed for build/migrate
npm run build
npm run migrate
npm prune --omit=dev # now safe to drop devDependencies
pm2 start ecosystem.config.js
pm2 startup systemd   # run the command it prints
pm2 save
pm2 install pm2-logrotate
```

### Nginx reverse proxy (`/etc/nginx/sites-available/savora-api`)

```nginx
server {
  listen 80;
  server_name api.yourdomain.com;

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
  }
}
```

`certbot --nginx` rewrites this in place to add the `listen 443 ssl` block and cert paths, and sets up auto-renewal.

### Deploying updates

```bash
# from your machine
git push vps-remote main   # or scp the repo / dist over

# on the VPS
cd ~/SavoraBackend
./scripts/deploy.sh   # git pull, npm ci, build, migrate, prune devDeps, pm2 reload
```

### Scaling out later

The app is fully stateless (JWT + Postgres only, no in-memory session state), so scaling is just:
1. Increase `instances` in `ecosystem.config.js` on the current box, or
2. Stand up a second VPS running the same app, point Postgres connections at the first box's DB (or a dedicated DB box), and put both app servers behind a load balancer (Nginx upstream or a managed LB).

Postgres itself stays a single primary for now; read replicas/sharding are future work, not needed at current scale.

## Environment variables

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_ACCESS_SECRET` | Signs 15-minute access tokens |
| `JWT_REFRESH_PEPPER` | Peppers refresh-token/OTP/reset-token hashes before storage |
| `GEMINI_API_KEY` | Server-side only — used by `/ai/parse-receipt` |
| `RESEND_API_KEY`, `MAIL_FROM` | Transactional email for OTP + password reset links |
| `CORS_ORIGIN` | Mobile app has no browser origin; `*` is fine, tighten if a web client is ever added |

`.env` must never be committed — it's already in `.gitignore`.
