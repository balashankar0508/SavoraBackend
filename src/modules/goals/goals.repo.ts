import { pool } from '../../db/pool';
import { Goal, GoalContribution } from '../../types/shared';

export async function listGoals(userId: string): Promise<Goal[]> {
  const { rows } = await pool.query<Goal>(
    'select * from goals where user_id = $1 order by created_at desc',
    [userId],
  );
  return rows;
}

export async function createGoal(
  userId: string,
  data: { title: string; target_amount: number; current_amount?: number; target_date: string },
): Promise<Goal> {
  const { rows } = await pool.query<Goal>(
    `insert into goals (user_id, title, target_amount, current_amount, target_date)
     values ($1, $2, $3, coalesce($4, 0), $5)
     returning *`,
    [userId, data.title, data.target_amount, data.current_amount ?? null, data.target_date],
  );
  return rows[0];
}

const GOAL_COLUMNS = new Set(['title', 'target_amount', 'current_amount', 'target_date']);

export async function updateGoal(
  userId: string,
  id: string,
  updates: Partial<{ title: string; target_amount: number; current_amount: number; target_date: string }>,
): Promise<Goal | null> {
  // only known columns can ever reach the SQL text (defence in depth: the schema also strips unknown keys)
  const fields = Object.keys(updates).filter(f => GOAL_COLUMNS.has(f));
  if (fields.length === 0) {
    const { rows } = await pool.query<Goal>('select * from goals where id = $1 and user_id = $2', [id, userId]);
    return rows[0] ?? null;
  }

  const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
  const values = fields.map(f => (updates as Record<string, unknown>)[f]);

  const { rows } = await pool.query<Goal>(
    `update goals set ${setClause} where id = $1 and user_id = $2 returning *`,
    [id, userId, ...values],
  );
  return rows[0] ?? null;
}

export async function deleteGoal(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('delete from goals where id = $1 and user_id = $2', [id, userId]);
  return (rowCount ?? 0) > 0;
}

/** Atomic server-side increment — replaces the client's read-modify-write,
 * which could race across two devices contributing to the same goal at once. */
export async function contributeToGoal(userId: string, id: string, amount: number): Promise<Goal | null> {
  const { rows } = await pool.query<Goal>(
    `update goals
     set current_amount = least(current_amount + $1, target_amount)
     where id = $2 and user_id = $3
     returning *`,
    [amount, id, userId],
  );
  return rows[0] ?? null;
}

export async function listContributions(userId: string, goalId: string): Promise<GoalContribution[] | null> {
  const owned = await pool.query('select 1 from goals where id = $1 and user_id = $2', [goalId, userId]);
  if (!owned.rowCount) return null;
  const { rows } = await pool.query<GoalContribution>(
    `select id, goal_id, amount, note, contribution_date::text as contribution_date, created_at
     from goal_contributions where goal_id = $1
     order by contribution_date desc, created_at desc`,
    [goalId],
  );
  return rows;
}

/** Inserts the contribution and bumps the goal total in one transaction. */
export async function addContribution(
  userId: string,
  goalId: string,
  data: { amount: number; note?: string; contribution_date: string; backfill?: boolean },
): Promise<{ goal: Goal; contribution: GoalContribution } | null> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const goalRes = await client.query<Goal>(
      `update goals set current_amount = least(current_amount + $1, target_amount)
       where id = $2 and user_id = $3 returning *`,
      [data.backfill ? 0 : data.amount, goalId, userId],
    );
    if (!goalRes.rows[0]) {
      await client.query('rollback');
      return null;
    }
    const { rows } = await client.query<GoalContribution>(
      `insert into goal_contributions (goal_id, user_id, amount, note, contribution_date)
       values ($1, $2, $3, $4, $5)
       returning id, goal_id, amount, note, contribution_date::text as contribution_date, created_at`,
      [goalId, userId, data.amount, data.note ?? null, data.contribution_date],
    );
    await client.query('commit');
    return { goal: goalRes.rows[0], contribution: rows[0] };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** Deletes the contribution and subtracts it from the goal total. */
export async function deleteContribution(
  userId: string,
  goalId: string,
  contributionId: string,
): Promise<Goal | null> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const del = await client.query<{ amount: number }>(
      'delete from goal_contributions where id = $1 and goal_id = $2 and user_id = $3 returning amount',
      [contributionId, goalId, userId],
    );
    if (!del.rows[0]) {
      await client.query('rollback');
      return null;
    }
    const { rows } = await client.query<Goal>(
      `update goals set current_amount = greatest(current_amount - $1, 0)
       where id = $2 and user_id = $3 returning *`,
      [del.rows[0].amount, goalId, userId],
    );
    await client.query('commit');
    return rows[0] ?? null;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
