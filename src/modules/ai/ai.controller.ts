import { Request, Response } from 'express';
import * as service from './ai.service';
import { parseReceiptSchema } from './ai.schemas';

export async function parseReceiptHandler(req: Request, res: Response) {
  const { image, mimeType } = parseReceiptSchema.parse(req.body);
  const data = await service.parseReceipt(req.userId, image, mimeType);
  res.json({ data });
}
