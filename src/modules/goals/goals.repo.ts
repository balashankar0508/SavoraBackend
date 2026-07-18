import { pool } from '../../db/pool';
import { Goal } from '../../types/shared';

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

export async function updateGoal(
  userId: string,
  id: string,
  updates: Partial<{ title: string; target_amount: number; current_amount: number; target_date: string }>,
): Promise<Goal | null> {
  const fields = Object.keys(updates);
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
