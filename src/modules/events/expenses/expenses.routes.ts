import { Request, Router } from 'express';
import { pool } from '../../../db/pool';
import { HttpError } from '../../../lib/httpError';
import { eventMutationLimiter } from '../../../middleware/rateLimit';
import { can } from '../access';
import { eventIdOf, idParam, route } from '../shared/http';
import { createExpenseSchema, listExpensesQuerySchema, updateExpenseSchema } from './expenses.schemas';
import * as svc from './expenses.service';

const router = Router({ mergeParams: true });

/** Who created the expense, for the "own expense vs someone else's" rule. */
async function expenseFacts(req: Request) {
  const { rows } = await pool.query('select created_by from event_expenses where id = $1 and event_id = $2', [idParam(req, 'expenseId'), eventIdOf(req)]);
  if (!rows[0]) throw new HttpError(404, 'expense_not_found');
  return { created_by: rows[0].created_by as string };
}

router.get('/expenses', can('event.view'), route(async (req, res) => {
  res.json(await svc.listExpenses(req.eventCtx!, listExpensesQuerySchema.parse(req.query)));
}));

router.get('/expenses/:expenseId', can('event.view'), route(async (req, res) => {
  res.json(await svc.getExpense(req.eventCtx!, idParam(req, 'expenseId')));
}));

router.post('/expenses', eventMutationLimiter, can('expense.create'), route(async (req, res) => {
  const { expense, created } = await svc.createExpense(eventIdOf(req), req.userId, createExpenseSchema.parse(req.body));
  res.status(created ? 201 : 200).json({ expense });
}));

router.patch('/expenses/:expenseId', eventMutationLimiter, can('expense.edit', expenseFacts), route(async (req, res) => {
  res.json(await svc.updateExpense(eventIdOf(req), req.userId, idParam(req, 'expenseId'), updateExpenseSchema.parse(req.body)));
}));

// "Delete" voids the expense; the record and its audit trail are kept.
router.delete('/expenses/:expenseId', eventMutationLimiter, can('expense.void', expenseFacts), route(async (req, res) => {
  res.json(await svc.voidExpense(eventIdOf(req), req.userId, idParam(req, 'expenseId')));
}));

export default router;
