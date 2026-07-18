import { Request, Response } from 'express';
import { HttpError } from '../../lib/httpError';
import * as repo from './transactions.repo';
import * as schemas from './transactions.schemas';

export async function listHandler(req: Request, res: Response) {
  const { since } = schemas.listTransactionsQuerySchema.parse(req.query);
  const transactions = await repo.listTransactions(req.userId, since);
  res.json({ transactions });
}

export async function createHandler(req: Request, res: Response) {
  const data = schemas.createTransactionSchema.parse(req.body);
  const transaction = await repo.createTransaction(req.userId, data);
  res.status(201).json({ transaction });
}

export async function updateHandler(req: Request, res: Response) {
  const updates = schemas.updateTransactionSchema.parse(req.body);
  const transaction = await repo.updateTransaction(req.userId, req.params.id, updates);
  if (!transaction) throw new HttpError(404, 'not_found');
  res.json({ transaction });
}

export async function deleteHandler(req: Request, res: Response) {
  const deleted = await repo.deleteTransaction(req.userId, req.params.id);
  if (!deleted) throw new HttpError(404, 'not_found');
  res.status(204).send();
}

export async function summaryHandler(req: Request, res: Response) {
  const { months } = schemas.summaryQuerySchema.parse(req.query);
  const monthlySummaries = await repo.monthlySummaries(req.userId, months);
  res.json({ monthlySummaries });
}
