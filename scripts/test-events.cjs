// Uses only a disposable local database, never DATABASE_URL from .env.
const { test, after, before } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
process.env.DATABASE_URL =
  "postgres://events_test@127.0.0.1:55439/spenxo_events_test";
process.env.JWT_ACCESS_SECRET = "events-test-only-access-secret-32-characters";
process.env.JWT_REFRESH_PEPPER =
  "events-test-only-refresh-pepper-32-characters";
process.env.GEMINI_API_KEY = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.BREVO_API_KEY = "test";
process.env.MAIL_FROM = "test@example.invalid";
process.env.NODE_ENV = "test";
const { Pool } = require("pg");
const {
  splitExpense,
  balances,
} = require("../dist/modules/events/events.math");
const { pool } = require("../dist/db/pool");
const { signAccessToken } = require("../dist/lib/jwt");
const express = require("express");
const { ZodError } = require("zod");
const router = require("../dist/modules/events/events.routes").default;
const experienceRouter = require("../dist/modules/events/events.experience.routes").default;
let server, base, owner, member, outsider, eventId;
const tokens = {};
async function request(user, method, url, body) {
  const response = await fetch(base + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { Authorization: `Bearer ${tokens[user]}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
before(async () => {
  const admin = new Pool({
    connectionString: "postgres://events_test@127.0.0.1:55439/postgres",
  });
  try {
    await admin.query("drop database if exists spenxo_events_test");
    await admin.query(
      "create database spenxo_events_test encoding 'UTF8' locale 'C' template template0"
    );
  } finally {
    await admin.end();
  }
  // This specifically named disposable database is rebuilt on each run.
  await pool.query("drop schema public cascade; create schema public");
  for (const file of fs
    .readdirSync(path.join(__dirname, "../migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pool.query(
      fs.readFileSync(path.join(__dirname, "../migrations", file), "utf8")
    );
  const users = [];
  for (const name of ["Owner", "Member", "Outsider"]) {
    const id = randomUUID();
    users.push(id);
    await pool.query(
      "insert into users(id,name,email,password_hash,email_verified) values($1,$2,$3,$4,true)",
      [id, name, `${name}@example.invalid`, "unused"]
    );
    tokens[id] = signAccessToken({
      userId: id,
      email: `${name}@example.invalid`,
    });
  }
  [owner, member, outsider] = users;
  const app = express();
  app.use(express.json());
  app.use("/events", router);
  app.use("/events", experienceRouter);
  app.use((e, r, s, n) =>
    s
      .status(e.status || (e instanceof ZodError ? 400 : 500))
      .json({ error: e.code || e.message })
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});
test("rounding preserves every paise and is deterministic", () => {
  const people = [
    { user_id: "c", value: 0 },
    { user_id: "a", value: 0 },
    { user_id: "b", value: 0 },
  ];
  assert.deepEqual(
    splitExpense(100, "equal", people).map((s) => s.amount_paise),
    [33, 34, 33]
  );
  for (let amount = 1; amount < 1000; amount++)
    assert.equal(
      splitExpense(amount, "equal", people).reduce(
        (n, s) => n + s.amount_paise,
        0
      ),
      amount
    );
  assert.deepEqual(
    splitExpense(101, "percentage", [
      { user_id: "a", value: 5000 },
      { user_id: "b", value: 5000 },
    ]).map((s) => s.amount_paise),
    [51, 50]
  );
  assert.throws(() =>
    splitExpense(100, "custom", [{ user_id: "a", value: 99 }])
  );
  assert.throws(() =>
    splitExpense(100, "equal", [
      { user_id: "a", value: 0 },
      { user_id: "a", value: 0 },
    ])
  );
  assert.throws(() =>
    splitExpense(100, "percentage", [{ user_id: "a", value: 9999 }])
  );
  assert.deepEqual(
    splitExpense(100, "shares", [
      { user_id: "a", value: 1 },
      { user_id: "b", value: 2 },
      { user_id: "c", value: 3 },
    ]).map((s) => s.amount_paise),
    [17, 33, 50]
  );
});
test("pending settlements do not change balances", () => {
  const expenses = [
    {
      paid_by: "a",
      amount_paise: 100,
      splits: [
        { user_id: "a", amount_paise: 50 },
        { user_id: "b", amount_paise: 50 },
      ],
    },
  ];
  assert.deepEqual(
    balances(["a", "b"], expenses, [
      { from_user: "b", to_user: "a", amount_paise: 50, confirmed: false },
    ]),
    { a: 50, b: -50 }
  );
  assert.deepEqual(
    balances(["a", "b"], expenses, [
      { from_user: "b", to_user: "a", amount_paise: 50, confirmed: true },
    ]),
    { a: 0, b: 0 }
  );
});
test("event lifecycle enforces membership, invitations, financial integrity and confirmation", async () => {
  assert.equal((await request(null, "GET", "/events")).status, 401);
  assert.equal(
    (
      await request(owner, "POST", "/events", {
        title: "Invalid",
        event_date: "2026-02-30",
        budget_paise: 100,
      })
    ).status,
    400
  );
  const creation = {
    id: randomUUID(),
    title: "Trip",
    event_date: "2026-10-01",
    budget_paise: 100000,
  };
  let r = await request(owner, "POST", "/events", creation);
  assert.equal(r.status, 201);
  eventId = r.body.event.id;
  assert.equal(
    (await request(owner, "POST", "/events", creation)).body.event.id,
    eventId
  );
  assert.equal(
    (await request(owner, "POST", "/events", { ...creation, title: "Changed" }))
      .status,
    409
  );
  assert.equal(
    (await request(outsider, "GET", `/events/${eventId}`)).status,
    404
  );
  assert.equal(
    (await request(outsider, "GET", "/events")).body.events.length,
    0
  );
  const old = (await request(owner, "POST", `/events/${eventId}/invites`)).body
    .token;
  const token = (await request(owner, "POST", `/events/${eventId}/invites`))
    .body.token;
  assert.equal(
    (await request(member, "POST", "/events/join", { token: old })).status,
    404
  );
  assert.equal(
    (await request(member, "POST", "/events/join", { token })).status,
    200
  );
  assert.equal(
    (await request(member, "POST", "/events/join", { token })).status,
    200
  );
  assert.equal(
    (await request(member, "POST", `/events/${eventId}/invites`)).status,
    403
  );
  const expense = {
    id: randomUUID(),
    title: "Lunch",
    category: "Food",
    amount_paise: 10001,
    expense_date: "2026-10-01",
    paid_by: owner,
    mode: "equal",
    splits: [
      { user_id: owner, value: 0 },
      { user_id: member, value: 0 },
    ],
  };
  assert.equal(
    (await request(outsider, "POST", `/events/${eventId}/expenses`, expense))
      .status,
    404
  );
  assert.equal(
    (
      await request(owner, "POST", `/events/${eventId}/expenses`, {
        ...expense,
        paid_by: outsider,
      })
    ).status,
    400
  );
  assert.equal(
    (
      await request(owner, "POST", `/events/${eventId}/expenses`, {
        ...expense,
        mode: "custom",
        splits: [{ user_id: owner, value: 1 }],
      })
    ).status,
    400
  );
  const responses = await Promise.all([
    request(owner, "POST", `/events/${eventId}/expenses`, expense),
    request(owner, "POST", `/events/${eventId}/expenses`, expense),
  ]);
  assert.ok(responses.every((r) => r.status === 201));
  assert.equal(
    (
      await request(owner, "POST", `/events/${eventId}/expenses`, {
        ...expense,
        title: "Changed",
      })
    ).status,
    409
  );
  r = await request(member, "GET", `/events/${eventId}`);
  assert.equal(r.body.members.length, 2);
  assert.equal(r.body.expenses.length, 1);
  assert.equal(
    Object.values(r.body.balances).reduce((a, b) => a + b, 0),
    0
  );
  assert.equal(
    (
      await request(
        member,
        "DELETE",
        `/events/${eventId}/expenses/${expense.id}`
      )
    ).status,
    403
  );
  const owed = -r.body.balances[member];
  assert.equal(
    (
      await request(owner, "PATCH", `/events/${eventId}/status`, {
        status: "completed",
      })
    ).status,
    409
  );
  const settlement = { id: randomUUID(), to_user: owner, amount_paise: owed };
  assert.equal(
    (
      await request(member, "POST", `/events/${eventId}/settlements`, {
        ...settlement,
        amount_paise: owed + 1,
      })
    ).status,
    400
  );
  assert.equal(
    (
      await request(
        member,
        "POST",
        `/events/${eventId}/settlements`,
        settlement
      )
    ).status,
    201
  );
  assert.equal(
    (
      await request(
        member,
        "POST",
        `/events/${eventId}/settlements`,
        settlement
      )
    ).status,
    201
  );
  assert.equal(
    (
      await request(member, "POST", `/events/${eventId}/settlements`, {
        ...settlement,
        id: randomUUID(),
      })
    ).status,
    409
  );
  assert.equal(
    (
      await request(
        member,
        "POST",
        `/events/${eventId}/settlements/${settlement.id}/confirm`
      )
    ).status,
    403
  );
  assert.equal((await request(owner, "POST", `/events/${eventId}/settlements/${settlement.id}/confirm`)).status, 409);
  const proof = {
    proof_name: "payment.png",
    proof_mime: "image/png",
    proof_data: Buffer.from("test payment proof image content").toString("base64"),
  };
  assert.equal((await request(outsider, "POST", `/events/${eventId}/settlements/${settlement.id}/proof`, proof)).status, 404);
  assert.equal((await request(member, "POST", `/events/${eventId}/settlements/${settlement.id}/proof`, proof)).body.settlement.status, "pending_approval");
  assert.equal((await request(owner, "GET", `/events/${eventId}/settlements/${settlement.id}/proof`)).body.data, proof.proof_data);
  assert.equal(
    (
      await request(
        owner,
        "DELETE",
        `/events/${eventId}/expenses/${expense.id}`
      )
    ).status,
    409
  );
  assert.equal(
    (
      await request(
        owner,
        "POST",
        `/events/${eventId}/settlements/${settlement.id}/confirm`
      )
    ).status,
    200
  );
  r = await request(owner, "GET", `/events/${eventId}`);
  assert.equal(r.body.balances[owner], 0);
  assert.equal(r.body.balances[member], 0);
  assert.equal(
    (
      await request(member, "PATCH", `/events/${eventId}/status`, {
        status: "completed",
      })
    ).status,
    403
  );
  assert.equal(
    (
      await request(owner, "PATCH", `/events/${eventId}/status`, {
        status: "completed",
      })
    ).status,
    200
  );
  assert.equal(
    (
      await request(owner, "POST", `/events/${eventId}/expenses`, {
        ...expense,
        id: randomUUID(),
      })
    ).status,
    409
  );
  assert.equal(
    (
      await request(owner, "PATCH", `/events/${eventId}/status`, {
        status: "active",
      })
    ).status,
    200
  );
  assert.equal((await request(owner, "POST", `/events/${eventId}/members/${member}/promote`)).status, 200);
  assert.equal((await request(owner, "POST", `/events/${eventId}/members/${member}/demote`)).status, 200);
  assert.equal((await request(owner, "POST", `/events/${eventId}/transfer-ownership`, { new_owner_id: member })).status, 200);
  assert.equal((await request(owner, "PATCH", `/events/${eventId}/status`, { status: "completed" })).status, 403);
  assert.equal((await request(member, "PATCH", `/events/${eventId}/status`, { status: "completed" })).status, 200);
  assert.equal((await request(owner, "POST", `/events/${eventId}/archive`)).status, 403);
  assert.equal((await request(member, "GET", `/events/${eventId}/audit-log`)).status, 200);
  assert.equal((await request(member, "POST", `/events/${eventId}/archive`)).status, 200);
  assert.equal((await request(member, "GET", "/events")).body.events.some((event) => event.id === eventId), false);

  const voidEvent = { id: randomUUID(), title: "Void test", event_date: "2026-11-01", budget_paise: 1000 };
  assert.equal((await request(owner, "POST", "/events", voidEvent)).status, 201);
  const voidExpense = { id: randomUUID(), title: "Correction", category: "Other", amount_paise: 500, expense_date: "2026-11-01", paid_by: owner, mode: "equal", splits: [{ user_id: owner, value: 0 }] };
  assert.equal((await request(owner, "POST", `/events/${voidEvent.id}/expenses`, voidExpense)).status, 201);
  assert.equal((await request(owner, "DELETE", `/events/${voidEvent.id}/expenses/${voidExpense.id}`)).status, 200);
  assert.equal((await request(owner, "GET", `/events/${voidEvent.id}`)).body.expenses.length, 0);
  assert.equal((await pool.query("select status from event_expenses where id=$1", [voidExpense.id])).rows[0].status, "voided");
});
