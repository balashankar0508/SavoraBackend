import { Router, Request, Response, NextFunction } from "express";
import { randomBytes, createHash, randomUUID } from "crypto";
import { z } from "zod";
import { PoolClient } from "pg";
import { pool } from "../../db/pool";
import { requireAuth } from "../../middleware/requireAuth";
import { HttpError } from "../../lib/httpError";
import { splitExpense, balances } from "./events.math";
const router = Router();
router.use(requireAuth);
const uuid = z.string().uuid();
const money = z.number().int().positive().max(1000000000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(s);
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function route(fn: (r: Request, s: Response) => Promise<unknown>) {
  return (r: Request, s: Response, n: NextFunction) => {
    fn(r, s).catch(n);
  };
}
async function transaction<T>(fn: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const value = await fn(c);
    await c.query("COMMIT");
    return value;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function access(c: PoolClient, id: string, user: string, active = false) {
  const { rows } = await c.query(
    "select e.* from events e join event_members m on m.event_id=e.id where e.id=$1 and m.user_id=$2 for update of e",
    [uuid.parse(id), user]
  );
  if (!rows[0]) throw new HttpError(404, "event_not_found");
  if (active && rows[0].status !== "active")
    throw new HttpError(409, "event_completed");
  return rows[0];
}
async function detail(c: PoolClient, id: string) {
  const event = (
    await c.query("select *, event_date::text from events where id=$1", [id])
  ).rows[0];
  const members = (
    await c.query(
      "select u.id, u.name from event_members m join users u on u.id=m.user_id where m.event_id=$1 order by m.joined_at,u.id",
      [id]
    )
  ).rows;
  const expenses = (
    await c.query(
      "select *, expense_date::text from event_expenses where event_id=$1 order by created_at desc",
      [id]
    )
  ).rows;
  const settlements = (
    await c.query(
      "select * from event_settlements where event_id=$1 order by created_at desc",
      [id]
    )
  ).rows;
  return {
    event,
    members,
    expenses,
    settlements,
    balances: balances(
      members.map((m) => m.id),
      expenses,
      settlements
    ),
  };
}
// Supplies a retry-safe operation ID without relying on a mobile UUID polyfill.
router.get(
  "/operation-id",
  route(async (_req, res) => res.json({ id: randomUUID() }))
);
router.get(
  "/",
  route(async (req, res) => {
    const { rows } = await pool.query(
      `select e.*, e.event_date::text,
 coalesce((select sum(amount_paise)::float8 from event_expenses where event_id=e.id),0) as spent_paise,
 (select count(*)::int from event_members where event_id=e.id) as member_count
 from events e join event_members m on m.event_id=e.id where m.user_id=$1 order by e.created_at desc`,
      [req.userId]
    );
    res.json({ events: rows });
  })
);
router.post(
  "/",
  route(async (req, res) => {
    const d = z
      .object({
        id: uuid,
        title: z.string().trim().min(1).max(100),
        event_date: date,
        budget_paise: money,
      })
      .parse(req.body);
    const event = await transaction(async (c) => {
      // Serializes retries before the event row exists.
      await c.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        d.id,
      ]);
      const previous = (
        await c.query("select *,event_date::text from events where id=$1", [
          d.id,
        ])
      ).rows[0];
      if (previous) {
        if (
          previous.owner_id === req.userId &&
          previous.title === d.title &&
          previous.event_date === d.event_date &&
          previous.budget_paise === d.budget_paise
        )
          return previous;
        throw new HttpError(409, "duplicate_id");
      }
      const { rows } = await c.query(
        "insert into events(id,owner_id,title,event_date,budget_paise) values($1,$2,$3,$4,$5) returning *",
        [d.id, req.userId, d.title, d.event_date, d.budget_paise]
      );
      await c.query(
        "insert into event_members(event_id,user_id) values($1,$2)",
        [rows[0].id, req.userId]
      );
      return rows[0];
    });
    res.status(201).json({ event });
  })
);
router.post(
  "/join",
  route(async (req, res) => {
    const { token } = z
      .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(req.body);
    const event = await transaction(async (c) => {
      const invite = (
        await c.query(
          "select event_id from event_invites where token_hash=$1 and expires_at>now()",
          [hash(token)]
        )
      ).rows[0];
      if (!invite) throw new HttpError(404, "invite_expired_or_invalid");
      const e = (
        await c.query("select * from events where id=$1 for update", [
          invite.event_id,
        ])
      ).rows[0];
      if (e.status !== "active") throw new HttpError(409, "event_completed");
      // Recheck after locking: an owner may have replaced the invitation.
      if (
        !(
          await c.query(
            "select 1 from event_invites where token_hash=$1 and expires_at>now()",
            [hash(token)]
          )
        ).rowCount
      )
        throw new HttpError(404, "invite_expired_or_invalid");
      const members = (
        await c.query("select user_id from event_members where event_id=$1", [
          e.id,
        ])
      ).rows;
      if (
        members.length >= 100 &&
        !members.some((m) => m.user_id === req.userId)
      )
        throw new HttpError(409, "event_member_limit");
      await c.query(
        "insert into event_members(event_id,user_id) values($1,$2) on conflict do nothing",
        [e.id, req.userId]
      );
      return e;
    });
    res.json({ event });
  })
);
router.get(
  "/:id",
  route(async (req, res) =>
    res.json(
      await transaction(async (c) => {
        await access(c, req.params.id, req.userId);
        return detail(c, req.params.id);
      })
    )
  )
);
router.post(
  "/:id/invites",
  route(async (req, res) => {
    const token = randomBytes(32).toString("hex");
    await transaction(async (c) => {
      const e = await access(c, req.params.id, req.userId, true);
      if (e.owner_id !== req.userId) throw new HttpError(403, "owner_required");
      await c.query("delete from event_invites where event_id=$1", [e.id]);
      await c.query(
        "insert into event_invites(token_hash,event_id) values($1,$2)",
        [hash(token), e.id]
      );
    });
    res.status(201).json({ token });
  })
);
router.post(
  "/:id/expenses",
  route(async (req, res) => {
    const d = z
      .object({
        id: uuid,
        title: z.string().trim().min(1).max(120),
        category: z.string().trim().min(1).max(40),
        amount_paise: money,
        expense_date: date,
        paid_by: uuid,
        mode: z.enum(["equal", "percentage", "custom"]),
        splits: z
          .array(
            z.object({
              user_id: uuid,
              value: z.number().int().min(0).max(1000000000),
            })
          )
          .min(1)
          .max(100),
      })
      .parse(req.body);
    await transaction(async (c) => {
      await access(c, req.params.id, req.userId, true);
      const members = (
        await c.query("select user_id from event_members where event_id=$1", [
          req.params.id,
        ])
      ).rows.map((m) => m.user_id);
      if (
        !members.includes(d.paid_by) ||
        d.splits.some((s) => !members.includes(s.user_id))
      )
        throw new HttpError(400, "invalid_member");
      const splits = splitExpense(d.amount_paise, d.mode, d.splits);
      const previous = (
        await c.query(
          "select *,expense_date::text from event_expenses where id=$1",
          [d.id]
        )
      ).rows[0];
      if (previous) {
        if (
          previous.event_id === req.params.id &&
          previous.created_by === req.userId &&
          previous.title === d.title &&
          previous.category === d.category &&
          previous.paid_by === d.paid_by &&
          previous.amount_paise === d.amount_paise &&
          previous.expense_date === d.expense_date &&
          JSON.stringify(
            previous.splits.map(
              (s: { user_id: string; amount_paise: number }) => [
                s.user_id,
                s.amount_paise,
              ]
            )
          ) === JSON.stringify(splits.map((s) => [s.user_id, s.amount_paise]))
        )
          return;
        throw new HttpError(409, "duplicate_id");
      }
      await c.query(
        "insert into event_expenses(id,event_id,created_by,paid_by,title,category,amount_paise,expense_date,splits) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          d.id,
          req.params.id,
          req.userId,
          d.paid_by,
          d.title,
          d.category,
          d.amount_paise,
          d.expense_date,
          JSON.stringify(splits),
        ]
      );
    });
    res.status(201).json({ ok: true });
  })
);
router.delete(
  "/:id/expenses/:expenseId",
  route(async (req, res) => {
    await transaction(async (c) => {
      const e = await access(c, req.params.id, req.userId, true);
      const x = (
        await c.query(
          "select * from event_expenses where id=$1 and event_id=$2",
          [uuid.parse(req.params.expenseId), e.id]
        )
      ).rows[0];
      if (!x) throw new HttpError(404, "expense_not_found");
      if (x.created_by !== req.userId && e.owner_id !== req.userId)
        throw new HttpError(403, "forbidden");
      const settled = await c.query(
        "select 1 from event_settlements where event_id=$1 limit 1",
        [e.id]
      );
      if (settled.rowCount) throw new HttpError(409, "settlements_exist");
      await c.query("delete from event_expenses where id=$1", [x.id]);
    });
    res.json({ ok: true });
  })
);
router.post(
  "/:id/settlements",
  route(async (req, res) => {
    const d = z
      .object({ id: uuid, to_user: uuid, amount_paise: money })
      .parse(req.body);
    await transaction(async (c) => {
      await access(c, req.params.id, req.userId, true);
      const previous = (
        await c.query("select * from event_settlements where id=$1", [d.id])
      ).rows[0];
      if (previous) {
        if (
          previous.event_id === req.params.id &&
          previous.from_user === req.userId &&
          previous.to_user === d.to_user &&
          previous.amount_paise === d.amount_paise
        )
          return;
        throw new HttpError(409, "duplicate_id");
      }
      const state = await detail(c, req.params.id);
      const b = state.balances;
      if (
        d.to_user === req.userId ||
        !(d.to_user in b) ||
        d.amount_paise > Math.min(-b[req.userId], b[d.to_user])
      )
        throw new HttpError(400, "invalid_settlement");
      if (
        state.settlements.some(
          (s) =>
            !s.confirmed &&
            (s.from_user === req.userId || s.to_user === d.to_user)
        )
      )
        throw new HttpError(409, "pending_settlement_exists");
      await c.query(
        "insert into event_settlements(id,event_id,from_user,to_user,amount_paise) values($1,$2,$3,$4,$5)",
        [d.id, req.params.id, req.userId, d.to_user, d.amount_paise]
      );
    });
    res.status(201).json({ ok: true });
  })
);
router.post(
  "/:id/settlements/:settlementId/confirm",
  route(async (req, res) => {
    await transaction(async (c) => {
      await access(c, req.params.id, req.userId, true);
      const s = (
        await c.query(
          "select * from event_settlements where id=$1 and event_id=$2",
          [uuid.parse(req.params.settlementId), req.params.id]
        )
      ).rows[0];
      if (!s || s.to_user !== req.userId)
        throw new HttpError(403, "recipient_required");
      if (s.confirmed) return;
      const b = (await detail(c, req.params.id)).balances;
      if (s.amount_paise > Math.min(-b[s.from_user], b[s.to_user]))
        throw new HttpError(409, "balance_changed");
      await c.query("update event_settlements set confirmed=true where id=$1", [
        s.id,
      ]);
    });
    res.json({ ok: true });
  })
);
router.delete(
  "/:id/settlements/:settlementId",
  route(async (req, res) => {
    await transaction(async (c) => {
      await access(c, req.params.id, req.userId, true);
      const r = await c.query(
        "delete from event_settlements where id=$1 and event_id=$2 and confirmed=false and (from_user=$3 or to_user=$3)",
        [uuid.parse(req.params.settlementId), req.params.id, req.userId]
      );
      if (!r.rowCount) throw new HttpError(404, "pending_settlement_not_found");
    });
    res.json({ ok: true });
  })
);
router.patch(
  "/:id/status",
  route(async (req, res) => {
    const { status } = z
      .object({ status: z.enum(["active", "completed"]) })
      .parse(req.body);
    await transaction(async (c) => {
      const e = await access(c, req.params.id, req.userId);
      if (e.owner_id !== req.userId) throw new HttpError(403, "owner_required");
      const d = await detail(c, e.id);
      if (
        status === "completed" &&
        (Object.values(d.balances).some((v) => v !== 0) ||
          d.settlements.some((s) => !s.confirmed))
      )
        throw new HttpError(409, "settle_balances_first");
      await c.query("update events set status=$1 where id=$2", [status, e.id]);
    });
    res.json({ ok: true });
  })
);
export default router;
