# Spenxo Backend

Self-hosted Node.js/TypeScript API for Spenxo, replacing Supabase (Postgres + Auth + Edge Functions). Raw `pg` (no ORM), JWT + bcrypt auth, deployed bare-metal on a VPS via PM2 + Nginx + Postgres, no Docker.

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

## Tests

```bash
npm test                 # unit tests: ledger, authorization policy, file storage, crypto, chat encryption, PDFs, CSV, notification messages
npm run typecheck:tests
npm run test:integration # builds, then runs the Events API tests (needs a throwaway Postgres, see below)
```

The integration tests run the real app over HTTP and **only** touch a disposable database. They need an
isolated PostgreSQL on `127.0.0.1:55439` with user `events_test` (trust auth); they drop and recreate
`spenxo_events_test` on every run, and never read `DATABASE_URL`:
```bash
initdb -D /tmp/spenxo-pg -U events_test --auth=trust
pg_ctl -D /tmp/spenxo-pg -o "-p 55439" start
```
To look at the generated PDFs while developing: `SPENXO_PDF_OUT=/tmp/pdfs npm test` writes sample files.

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
| `GEMINI_API_KEY` | Server-side only — primary model for `/ai/parse-receipt` |
| `ANTHROPIC_API_KEY` | Optional — Claude Haiku 4.5 fallback for `/ai/parse-receipt` when Gemini is overloaded (503). Leave unset to skip the fallback. |
| `BREVO_API_KEY`, `MAIL_FROM` | Transactional email (Brevo) for OTP + password reset links |
| `CORS_ORIGIN` | Mobile app has no browser origin; `*` is fine, tighten if a web client is ever added |
| `UPLOAD_DIR` | Private folder for event receipts, payment proofs and chat images. Must be outside the repo and web root. Production: `/var/lib/spenxo/uploads`, mode `700`, owned by the app user. Include it in backups. |
| `CHAT_ENCRYPTION_KEY` | 64 hex chars (`openssl rand -hex 32`). AES-256-GCM key for chat messages at rest. **Required** - the server will not start without it. Losing it makes old chat unreadable, so back it up separately from the database. |
| `INVITE_CODE_KEY` | 64 hex chars (`openssl rand -hex 32`). Keys the lookup hash and encrypted copy of event invite codes. **Required.** Do not reuse the JWT secrets. |

| `FIREBASE_SERVICE_ACCOUNT_PATH` | Optional. Path to a Firebase service-account JSON (kept outside the repo, `chmod 600`) that enables push notifications. Unset = the API works as normal and pushes are skipped. |

`.env` must never be committed — it's already in `.gitignore`.

## Events

The Events module (shared expenses, balances, settlements, chat, reports, push) is documented in
[EVENTS.md](EVENTS.md): permissions, money rules, security model, the full API list, notification rules and rollout notes.

### Push notifications (Firebase Cloud Messaging)

1. In the [Firebase console](https://console.firebase.google.com) create a project and add an **Android app** with package name `com.savora.app`. Download `google-services.json` for the mobile app (`Savora/android/app/`).
2. **Project settings → Service accounts → Generate new private key.** Copy that JSON to the server, e.g. `/root/.config/spenxo-firebase.json`, `chmod 600` it, and set `FIREBASE_SERVICE_ACCOUNT_PATH` to its path.
3. `./scripts/deploy.sh` (or `pm2 reload ecosystem.config.js --update-env`). The startup log shows a warning when pushes are disabled.

Pushes never contain chat text or payment details. Devices that Google reports as uninstalled are removed from `device_tokens` automatically.

## Database backups

`scripts/backup-db.sh` dumps Postgres **and archives the uploads folder** (`UPLOAD_DIR`: receipts, payment screenshots, chat images), uploads both to Google Drive, and keeps the last 7 days locally (`/root/db-backups`) and on Drive. Run daily via cron.

Two things to know:
- **Keep `CHAT_ENCRYPTION_KEY` and `INVITE_CODE_KEY` somewhere else** (a password manager). The script deliberately does not back up `.env`: a database backup stored next to its own keys would defeat the encryption, and without the chat key the old chat messages cannot be read.
- The uploads archive contains private payment screenshots. Share the Drive folder with the service account only, or use an rclone `crypt` remote.

To restore: `gunzip -c savora-DATE.sql.gz | sudo -u postgres psql savora` and `tar -xzf uploads-DATE.tar.gz -C $(dirname $UPLOAD_DIR)`, then restore the two keys into `.env`.

One-time setup on Google Cloud (console.cloud.google.com):
1. **APIs & Services → Library** → enable the **Google Drive API** for your project.
2. **APIs & Services → Credentials → Create Credentials → Service Account** — name it e.g. `spenxo-backup`, skip optional role grants (access comes from folder sharing, not IAM).
3. Open the new service account → **Keys → Add Key → Create new key → JSON** — downloads a key file. Copy it to the server, e.g. `/root/.config/spenxo-gdrive-sa.json`, and `chmod 600` it.
4. In regular Google Drive, create a folder (e.g. "Spenxo DB Backups"), right-click → **Share**, and add the service account's email (`...@<project-id>.iam.gserviceaccount.com`) as **Editor**. Copy the folder's ID from its URL (`.../folders/<FOLDER_ID>`).

One-time setup on the server:
```bash
curl https://rclone.org/install.sh | sudo bash

rclone config create gdrive drive \
  scope=drive \
  service_account_file=/root/.config/spenxo-gdrive-sa.json \
  root_folder_id=<FOLDER_ID>

chmod +x scripts/backup-db.sh
crontab -e
# add this line (daily at 2am server time):
# 0 2 * * * /root/SavoraBackend/scripts/backup-db.sh >> /root/db-backups/backup.log 2>&1
```
