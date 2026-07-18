import { pool } from '../../db/pool';
import { Transaction, MonthlySummary } from '../../types/shared';

function monthsAgoISODate(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

export async function listTransactions(userId: string, since?: string): Promise<Transaction[]> {
  const sinceDate = since ?? monthsAgoISODate(3);
  const { rows } = await pool.query<Transaction>(
    `select * from transactions
     where user_id = $1 and transaction_date >= $2
     order by transaction_date desc, created_at desc`,
    [userId, sinceDate],
  );
  return rows;
}

export async function createTransaction(
  userId: string,
  data: {
    type: string;
    amount: number;
    category: string;
    notes?: string;
    transaction_date: string;
    merchant_name?: string;
    source: string;
  },
): Promise<Transaction> {
  const { rows } = await pool.query<Transaction>(
    `insert into transactions (user_id, type, amount, category, notes, transaction_date, merchant_name, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning *`,
    [
      userId,
      data.type,
      data.amount,
      data.category,
      data.notes ?? null,
      data.transaction_date,
      data.merchant_name ?? null,
      data.source,
    ],
  );
  return rows[0];
}

export async function updateTransaction(
  userId: string,
  id: string,
  updates: Partial<{
    type: string;
    amount: number;
    category: string;
    notes: string;
    transaction_date: string;
    merchant_name: string;
    source: string;
  }>,
): Promise<Transaction | null> {
  const fields = Object.keys(updates);
  if (fields.length === 0) {
    const { rows } = await pool.query<Transaction>(
      'select * from transactions where id = $1 and user_id = $2',
      [id, userId],
    );
    return rows[0] ?? null;
  }

  const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
  const values = fields.map(f => (updates as Record<string, unknown>)[f]);

  const { rows } = await pool.query<Transaction>(
    `update transactions set ${setClause} where id = $1 and user_id = $2 returning *`,
    [id, userId, ...values],
  );
  return rows[0] ?? null;
}

export async function deleteTransaction(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'delete from transactions where id = $1 and user_id = $2',
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function monthlySummaries(userId: string, months: number): Promise<MonthlySummary[]> {
  const sinceDate = monthsAgoISODate(months);
  const { rows } = await pool.query<{ month: string; income: string; expenses: string }>(
    `select
       to_char(date_trunc('month', transaction_date), 'YYYY-MM') as month,
       coalesce(sum(amount) filter (where type = 'income'), 0) as income,
       coalesce(sum(amount) filter (where type = 'expense'), 0) as expenses
     from transactions
     where user_id = $1 and transaction_date >= $2
     group by 1
     order by 1 asc`,
    [userId, sinceDate],
  );

  return rows.map(r => ({
    month: r.month,
    income: Number(r.income),
    expenses: Number(r.expenses),
    savings: Number(r.income) - Number(r.expenses),
  }));
}
