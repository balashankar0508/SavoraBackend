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

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
});
