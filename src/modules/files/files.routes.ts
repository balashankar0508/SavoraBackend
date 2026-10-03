import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../../middleware/requireAuth';
import { uploadLimiter } from '../../middleware/rateLimit';
import { HttpError } from '../../lib/httpError';
import { can, eventContext } from '../events/access';
import { MAX_FILE_BYTES, findFile, saveFile, storage } from './files.service';

const router = Router();
const uuid = z.string().uuid();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 4, parts: 6 },
});

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

// Authorise BEFORE multer buffers the body, so non-members cannot make us read uploads.
router.post(
  '/events/:eventId/files',
  requireAuth,
  uploadLimiter,
  eventContext(),
  can('file.upload'),
  upload.single('file'),
  wrap(async (req, res) => {
    const { purpose } = z.object({ purpose: z.enum(['receipt', 'proof', 'chat']) }).parse(req.body);
    if (!req.file) throw new HttpError(400, 'file_required');
    const file = await saveFile({
      eventId: req.eventCtx!.event.id,
      ownerId: req.userId,
      purpose,
      buffer: req.file.buffer,
    });
    res.status(201).json({
      file: { id: file.id, purpose: file.purpose, mime: file.mime, size_bytes: file.size_bytes, created_at: file.created_at },
    });
  }),
);

// Never a public URL: membership of the file's event is re-checked on every read.
router.get(
  '/files/:id',
  requireAuth,
  eventContext(async req => {
    const id = uuid.safeParse(req.params.id);
    const file = id.success ? await findFile(id.data) : null;
    if (!file) throw new HttpError(404, 'file_not_found');
    req.fileRow = file;
    return file.event_id;
  }),
  can('file.read', req => ({ event_id: req.fileRow!.event_id })),
  wrap(async (req, res) => {
    const file = req.fileRow!;
    if (!(await storage.exists(file.storage_key))) throw new HttpError(404, 'file_not_found');
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', String(file.size_bytes));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'inline');
    const stream = storage.createReadStream(file.storage_key);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }),
);

export default router;
