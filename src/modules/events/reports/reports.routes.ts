import { Response, Router } from 'express';
import { reportLimiter } from '../../../middleware/rateLimit';
import { can } from '../access';
import { idParam, route } from '../shared/http';
import * as svc from './reports.service';

/** Mounted under /events/:eventId. */
const router = Router({ mergeParams: true });

/** Files are sent as attachments, never cached, never sniffed into another type. */
function download(res: Response, file: { filename: string; body: Buffer | string }, type: string) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(file.body);
}

router.get('/analytics', can('analytics.view'), route(async (req, res) => {
  res.json(await svc.getAnalytics(req.eventCtx!, svc.analyticsQuerySchema.parse(req.query)));
}));

router.get('/summary', can('event.view'), route(async (req, res) => {
  res.json(await svc.getSummary(req.eventCtx!));
}));

router.get('/report.pdf', reportLimiter, can('event.view'), route(async (req, res) => {
  download(res, await svc.buildReportPdf(req.eventCtx!), 'application/pdf');
}));

router.get('/settlements.csv', reportLimiter, can('event.view'), route(async (req, res) => {
  download(res, await svc.buildSettlementsCsv(req.eventCtx!), 'text/csv; charset=utf-8');
}));

router.get('/settlements/:settlementId/receipt.pdf', reportLimiter, can('event.view'), route(async (req, res) => {
  download(res, await svc.buildReceiptPdf(req.eventCtx!, idParam(req, 'settlementId')), 'application/pdf');
}));

export default router;
