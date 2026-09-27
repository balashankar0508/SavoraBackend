# Events implementation and rollout

This is the first usable Events release: budgets, invitations, shared expenses,
balances and confirmed settlement records. Chat is not implemented or advertised
as encrypted. No plaintext chat endpoint has been introduced.

## Included

- Authenticated event list, creation and member-only detail.
- INR budgets and expenses stored as integer paise, capped at INR 10,000,000 per amount.
- Owner-generated, 256-bit random invitation codes, stored hashed, expiring in seven days.
  Generating a new code invalidates the previous one. Up to 100 members per event.
- Equal, custom-amount and percentage splits (percentage API values are basis points:
  10000 means 100%). Largest-remainder allocation preserves every paise.
- Payer and split participants must belong to the event. Members can record an expense
  on another member's behalf; these are bookkeeping records, not bank verification.
- Retry IDs on event creation, expenses and settlements. Reusing an ID with a different
  payload is rejected. Event row locks serialize financial writes and settlement checks.
- Positive balances mean the member should receive money; negative means they owe money.
- Only a debtor can record a payment; only its recipient can confirm receipt.
  Pending payments do not affect balances. Either party can cancel a pending record.
- Expense deletion is limited to its author/owner and blocked once settlement records exist.
- Owner-only completion/reopening. Completion requires zero balances and no pending payments.
- Event data is separate from personal transactions to avoid counting reimbursements twice.

## Deployment

1. Back up PostgreSQL using the existing operational procedure.
2. Deploy the backend with the existing `scripts/deploy.sh`: it builds and applies
   `migrations/003_events.sql` before PM2 reload. No new server package is needed.
3. Verify `/health` and the authenticated Events flow with two test accounts.
4. Build and distribute the updated mobile app after the API is available.

The migration adds tables only; it does not alter existing personal-finance tables.
For a code rollback, keep these tables and their data. Do not drop them after users
have created events. This work has not deployed or migrated your live server.

## Integration tests

`npm run build` then `node --test scripts/test-events.cjs`.

The test script deliberately ignores the application's DATABASE_URL. It expects an
isolated PostgreSQL cluster at `127.0.0.1:55439`, user `events_test`, and recreates ONLY
the disposable database `spenxo_events_test`. Do not place useful data in that database.
It applies all migrations and exercises authenticated HTTP requests through the actual
events router. Tests cover membership isolation, invalid dates, invite replacement,
duplicate/retried writes, exact rounding, payer authorization, settlement confirmation,
and completion permissions. The test server closes afterward.

## Remaining work from the PDF and encryption plan

- E2EE group chat, chat attachment encryption, device identity verification, device
  linking/recovery, membership key rotation and realtime delivery. Select and validate
  a maintained protocol implementation before introducing chat endpoints.
- Receipt/file storage and uploads, QR/deep-link invitation acceptance, category budget
  allocations, event editing/member removal, richer analytics and downloadable summaries.
- Push notification workers and durable offline synchronization.
- Pagination and operational limits for large event histories.

Financial records remain server-readable. Do not describe this release as end-to-end
encrypted. This first release does not process payments or verify external transfers.
