# Events (v2)

Shared event budgets, expenses, balances, settlements, group chat, reports and push
notifications. Rebuilt in migration `008_events_v2.sql` (it **drops** the pre-v2 event tables).
Code: `src/modules/events/*`, `src/modules/files`, `src/modules/notifications`.

Spenxo **records** who paid whom. It does not move money and it does not verify bank
transfers: a payer marks a payment as paid, and the recipient confirms they received it.

## How the code is organised

| Folder | Responsibility |
|---|---|
| `events/ledger/` | **All money maths.** Pure functions, no DB/HTTP: `money`, `split`, `balances`, `simplify`, `stats`, `invariants`. |
| `events/access/` | **All authorization.** One permission table (`policy.ts`), `eventContext()` + `can(action)` for routes, `withEventLock()` for writes. |
| `events/events`, `membership`, `invitations`, `expenses`, `settlements`, `chat`, `reports` | One service + routes + schemas per area. |
| `files/` | Private upload storage behind a `StorageDriver` interface (local disk today). |
| `notifications/` | Device tokens, per-event switches, FCM delivery. |

Two rules keep this safe:

1. **Money is computed in exactly one place** (`ledger/`). The app shows what the server returns; its only copy of the maths is the live split preview, tested against the same vectors (`ledger/__fixtures__/split-vectors.json`).
2. **No route checks roles by hand.** Every route is `can('<action>')`, and services re-check inside the event lock, so a stale request can never act on old membership or settings.

## Money rules

- Amounts are integer **paise** (max ₹1,00,00,000 per amount). No floats are stored or sent.
- Splits (equal / exact / percentage in basis points / shares) use largest-remainder rounding: shares always add up to exactly the amount, and ties break by user id, so the result never depends on input order.
- A balance is *positive = owed money, negative = owes money*. Only **active expenses** and **confirmed settlements** count; pending payments never move a balance. All balances sum to 0.
- Every money write runs in one transaction under a row lock on the event, is checked for idempotency (client-generated ids), is validated against the ledger, and ends with `assertLedgerConsistent` before commit. A violation rolls everything back.
- Payers and everyone in a split must be **active members**.
- Expenses are never erased: "delete" voids them, and edits keep the old values in the audit log.
- A payment is limited to what the payer owes and the recipient is owed, checked when it is marked paid **and again when it is confirmed** (`balance_changed` if the debt shrank meanwhile).
- Completing an event needs all balances at 0 and no pending payments; a completed or archived event is read-only (reopen is owner-only).

## Roles and permissions

Roles: **owner** (one per event), **admin**, **member**. Non-members of an event get `404 event_not_found` on every route, so an event's existence is never revealed.

| | Owner | Admin | Member |
|---|---|---|---|
| View event, balances, expenses, chat, analytics, reports | ✓ | ✓ | ✓ |
| Edit details / settings, invite codes, approve join requests, remove members | ✓ | ✓ (members only) | – |
| Promote / demote admins, complete / reopen / archive / delete / duplicate, transfer ownership | ✓ | – | – |
| Add expenses | ✓ | ✓ | if "Allow member expense entry" is on |
| Edit / void expenses | ✓ | ✓ | their own (anyone's if "Member editing rules" is on) |
| Mark a payment as paid | debtor only (any role) | | |
| Confirm / reject a payment | the recipient, or the owner (never the payer) | | |
| Chat (read / write) | ✓ | ✓ | ✓ (write only while the event is active) |
| Delete chat messages | any | any | their own |
| See an invite code | ✓ | ✓ | only when "anyone with the code" can join |

State problems return `409` with the reason (`event_not_active`, `wrong_state`, …); permission problems return `403 forbidden_<action>`.

## Joining

- Codes look like `SPX-7K4M-92QD` (8 random Crockford-base32 characters), expire after 7 days, and are stored as a keyed hash plus an encrypted copy so admins can show them again. Regenerating or revoking kills the old code immediately.
- Policies: **admins only** (needs an email invitation), **anyone with the code**, **code + approval**. A previously removed member needs approval to return, whatever the policy. An admin's email invitation to your address admits you directly.
- Wrong, expired, revoked and replaced codes all return the same `404 invite_expired_or_invalid`. Attempts are limited to 10 per 15 minutes per user and IP. Events hold at most 100 active members.

## Settlements

1. Payer picks UPI / bank / cash / other, pays outside Spenxo (the app can open GPay, PhonePe, Paytm, BHIM), then taps **Mark as paid**, with an optional UTR and screenshot. Status `pending_confirmation`, reference `TXN-XXXX-XXXX`.
2. Recipient (or owner) **confirms** → the balance moves. Or **rejects** (with an optional reason) / the payer **cancels**; either frees the pair for another attempt. One open payment per payer→recipient pair.
3. **Remind** / **Request payment**: only a creditor to someone who really owes them, once per 24 h per kind.

Payment screenshots are visible only to the payer, the recipient and admins. Receipts are visible to the two people involved and admins.

## Chat

- Messages are encrypted at rest with **AES-256-GCM** using `CHAT_ENCRYPTION_KEY`; the event id and message id are bound in as authenticated data, so a ciphertext cannot be moved to another event or message. Tampered rows show as `unreadable` instead of breaking the conversation.
- **This is not end-to-end encryption**: the server can decrypt. The app must say "protected in transit and at rest", never "end-to-end".
- System cards ("Priya added Cake — ₹2,000") are written by the services in the same transaction as the change. They are not encrypted; they contain only what the activity feed already shows.
- Deleting a message wipes its content (and an attached image's file) for everyone.
- Polling: `GET /messages` returns the latest page; `GET /messages?since=<server_time>` returns new and deleted messages. It deliberately re-sends the last 15 seconds so a slow transaction can't be missed; clients de-duplicate by id.

## Push notifications

Sent after the database commit, so a failing push can never fail or roll back a request. Without `FIREBASE_SERVICE_ACCOUNT_PATH` pushes are skipped.

| Event | Who | Controlled by |
|---|---|---|
| Expense added / updated / removed | other members | **Expense updates** (default on) |
| Member joined / left | other members | **Member activity** (default **off**) |
| Join request | owner + admins | always |
| Request approved / declined, removed from event | that person | always |
| Payment marked paid, confirmed, rejected, cancelled | the other person involved | **Settlement updates** (default on) |
| Reminder / payment request | the debtor | always |
| Chat message | other members | **Chat notifications** (default on) |
| Event completed / reopened | other members | **Settlement updates** |
| Event deleted | all members but the owner | always |

Chat pushes say "<name> sent a message" and never contain the text. No UPI IDs, UTRs or bank details are ever sent through push. Each push carries `data.route` (`event`, `expenses`, `balances`, `settlements`, `chat`, `members`, `events`) plus `eventId` (and `settlementId` / `expenseId`) so the app can open the right screen. The Android channel id is `spenxo-events`.

## API

All routes need `Authorization: Bearer <access token>`. Errors are `{ "error": "<code>", "requestId": "…" }`. `:id` = event id.

**Events**: `GET /events` · `POST /events` · `POST /events/join` · `GET /events/:id` (dashboard payload with `permissions`) · `PATCH /events/:id` · `PATCH /events/:id/settings` · `POST /events/:id/complete|reopen|archive|duplicate|transfer-ownership|leave` · `DELETE /events/:id` (body `{"confirm": true}`; irreversible)

**Members**: `GET /events/:id/members` · `GET /events/:id/members/:uid/payment-profile` · `POST /events/:id/members/:uid/approve|reject|promote|demote|remove`

**Invitations**: `GET /events/:id/invite-code` · `POST …/invite-code/regenerate|revoke` · `GET /events/:id/invitations` · `POST /events/:id/email-invitations` · `POST …/email-invitations/:iid/resend|cancel`

**Expenses**: `GET|POST /events/:id/expenses` · `GET|PATCH|DELETE /events/:id/expenses/:eid`

**Balances & settlements**: `GET /events/:id/balances` · `GET|POST /events/:id/settlements` · `POST …/settlements/:sid/confirm|reject|cancel` · `POST /events/:id/remind`

**Chat**: `GET|POST /events/:id/messages` · `DELETE /events/:id/messages/:mid`

**Reports**: `GET /events/:id/analytics?window=all|week|month&today=YYYY-MM-DD` · `GET …/summary` · `GET …/report.pdf` · `GET …/settlements.csv` · `GET …/settlements/:sid/receipt.pdf`

**Files**: `POST /events/:id/files` (multipart `file` + `purpose` = receipt | proof | chat; JPEG/PNG/WebP, 5 MB) · `GET /files/:id`

**Notifications**: `GET|PUT /events/:id/notification-prefs` · `POST|DELETE /me/device-tokens`

**Me**: `GET|PUT|DELETE /me/payment-profile` (your UPI ID, reused in every event)

## Files and PDFs

- Uploads are checked by their first bytes (the declared type is ignored), stored under `UPLOAD_DIR/events/<eventId>/<fileId>.<ext>` with random names, never served directly, and re-authorised on every read. Deleting an event removes its folder.
- PDFs use DejaVu Sans (it has the ₹ sign). Names in scripts that font lacks (Tamil, Hindi, …) appear as empty boxes in PDFs; the app itself is unaffected.
- CSV cells that start with `= + - @` are prefixed with `'` so spreadsheets can't run them as formulas.

## Rate limits

Per user unless noted: 30 writes/min, 10 join attempts/15 min (per user+IP), 20 uploads/hour, 60 chat messages/min, 20 PDF/CSV downloads/min, 20 invitation emails/day/event. A global 120 requests/min per IP also applies.

## Rollout

1. Back up the database (`scripts/backup-db.sh`).
2. Set `CHAT_ENCRYPTION_KEY` and `INVITE_CODE_KEY` (`openssl rand -hex 32` each) in `.env`, and store both in a password manager. Optionally set `FIREBASE_SERVICE_ACCOUNT_PATH`.
3. `./scripts/deploy.sh`. It refuses to continue if the keys are missing, creates `UPLOAD_DIR` (mode 700), builds, runs migrations and reloads PM2.
4. **Migration 008 permanently deletes existing events, expenses, settlements and chat.** Personal transactions and goals are untouched.
5. Verify `/health`, then try it with two phones before releasing the new mobile build: create and join (code, link, approval), a ₹100.01 split, pay → confirm → balance moves, chat plus a push while backgrounded, complete and reopen, delete. The previous mobile build's Events screens do not work against this API.

## Not included (yet)

Currencies other than INR · real-time sockets (chat polls every few seconds, push covers the rest) · end-to-end encryption · in-app payment gateway or automatic payment verification · user-uploaded event cover photos · an offline write queue · iOS UPI handling.
