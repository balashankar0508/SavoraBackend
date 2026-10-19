import { Pool, types } from 'pg';
import { env } from '../config/env';

// pg returns NUMERIC/DECIMAL columns (amount, target_amount, current_amount)
// as strings by default, to avoid float precision loss on arbitrary-precision
// values. Our schema only ever uses numeric(12,2) for plain money amounts, so
// parse them back to JS numbers globally -- otherwise every Transaction/Goal
// amount is silently a string at runtime despite being typed `number`, and
// reduce((s, t) => s + t.amount, 0) on the client does string concatenation
// instead of addition once there's more than one row.
types.setTypeParser(types.builtins.NUMERIC, (val) => parseFloat(val));

// bigint (SUM/COUNT, int8) comes back as a string by default. Every value in
// this schema is far below 2^53 (money is capped at 1e9 paise per row), so
// parse to numbers for the same reason as NUMERIC above.
types.setTypeParser(types.builtins.INT8, (val) => parseInt(val, 10));

// DATE columns (transaction_date, target_date, expense_date ...) are calendar days. By default pg turns
// them into a JS Date at midnight, which JSON-encodes as "2026-10-19T00:00:00.000Z": the app then shows
// that text and sends it back, and the "YYYY-MM-DD" validation rejects it. Keep the plain day string.
types.setTypeParser(types.builtins.DATE, (val) => val);

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
});
