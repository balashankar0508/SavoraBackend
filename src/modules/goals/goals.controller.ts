import { Request, Response } from 'express';
import { HttpError } from '../../lib/httpError';
import * as repo from './goals.repo';
import * as schemas from './goals.schemas';

export async function listHandler(req: Request, res: Response) {
  const goals = await repo.listGoals(req.userId);
  res.json({ goals });
}

export async function createHandler(req: Request, res: Response) {
  const data = schemas.createGoalSchema.parse(req.body);
  const goal = await repo.createGoal(req.userId, data);
  res.status(201).json({ goal });
}

export async function updateHandler(req: Request, res: Response) {
  const updates = schemas.updateGoalSchema.parse(req.body);
  const goal = await repo.updateGoal(req.userId, req.params.id, updates);
  if (!goal) throw new HttpError(404, 'not_found');
  res.json({ goal });
}

export async function deleteHandler(req: Request, res: Response) {
  const deleted = await repo.deleteGoal(req.userId, req.params.id);
  if (!deleted) throw new HttpError(404, 'not_found');
  res.status(204).send();
}

export async function contributeHandler(req: Request, res: Response) {
  const { amount } = schemas.contributeSchema.parse(req.body);
  const goal = await repo.contributeToGoal(req.userId, req.params.id, amount);
  if (!goal) throw new HttpError(404, 'not_found');
  res.json({ goal });
}

export async function listContributionsHandler(req: Request, res: Response) {
  const contributions = await repo.listContributions(req.userId, req.params.id);
  if (!contributions) throw new HttpError(404, 'not_found');
  res.json({ contributions });
}

export async function addContributionHandler(req: Request, res: Response) {
  const data = schemas.addContributionSchema.parse(req.body);
  const result = await repo.addContribution(req.userId, req.params.id, data);
  if (!result) throw new HttpError(404, 'not_found');
  res.status(201).json(result);
}

export async function deleteContributionHandler(req: Request, res: Response) {
  const goal = await repo.deleteContribution(req.userId, req.params.id, req.params.contributionId);
  if (!goal) throw new HttpError(404, 'not_found');
  res.json({ goal });
}
