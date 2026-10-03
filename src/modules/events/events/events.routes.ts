import { Router } from 'express';
import { z } from 'zod';
import { eventMutationLimiter } from '../../../middleware/rateLimit';
import { can } from '../access';
import { eventIdOf, route } from '../shared/http';
import * as svc from './events.service';
import {
  createEventSchema, deleteEventSchema, duplicateEventSchema, listEventsQuerySchema, updateEventSchema, updateSettingsSchema,
} from './events.schemas';

/** /events and /events/join live here; everything under /events/:eventId is in `eventRoutes`. */
export const collectionRoutes = Router();

collectionRoutes.get('/', route(async (req, res) => {
  res.json(await svc.listEvents(req.userId, listEventsQuerySchema.parse(req.query)));
}));

collectionRoutes.post('/', eventMutationLimiter, route(async (req, res) => {
  const event = await svc.createEvent(req.userId, createEventSchema.parse(req.body));
  res.status(201).json({ event });
}));

/** Mounted at /events/:eventId, after eventContext() has loaded the caller's membership. */
export const eventRoutes = Router({ mergeParams: true });

eventRoutes.get('/', can('event.view'), route(async (req, res) => {
  res.json(await svc.getEventDetail(req.eventCtx!));
}));

eventRoutes.patch('/', eventMutationLimiter, can('event.edit'), route(async (req, res) => {
  const event = await svc.updateEvent(eventIdOf(req), req.userId, updateEventSchema.parse(req.body));
  res.json({ event });
}));

eventRoutes.patch('/settings', eventMutationLimiter, can('settings.edit'), route(async (req, res) => {
  const event = await svc.updateSettings(eventIdOf(req), req.userId, updateSettingsSchema.parse(req.body));
  res.json({ event });
}));

eventRoutes.post('/complete', eventMutationLimiter, can('event.complete'), route(async (req, res) => {
  res.json({ event: await svc.completeEvent(eventIdOf(req), req.userId) });
}));

eventRoutes.post('/reopen', eventMutationLimiter, can('event.reopen'), route(async (req, res) => {
  res.json({ event: await svc.reopenEvent(eventIdOf(req), req.userId) });
}));

eventRoutes.post('/archive', eventMutationLimiter, can('event.archive'), route(async (req, res) => {
  res.json({ event: await svc.archiveEvent(eventIdOf(req), req.userId) });
}));

eventRoutes.post('/duplicate', eventMutationLimiter, can('event.duplicate'), route(async (req, res) => {
  const event = await svc.duplicateEvent(eventIdOf(req), req.userId, duplicateEventSchema.parse(req.body ?? {}));
  res.status(201).json({ event });
}));

eventRoutes.post('/transfer-ownership', eventMutationLimiter, can('ownership.transfer'), route(async (req, res) => {
  const { new_owner_id } = z.object({ new_owner_id: z.string().uuid() }).strict().parse(req.body);
  res.json(await svc.transferOwnership(eventIdOf(req), req.userId, new_owner_id));
}));

eventRoutes.delete('/', eventMutationLimiter, can('event.delete'), route(async (req, res) => {
  deleteEventSchema.parse(req.body ?? {}); // must explicitly confirm; it cannot be undone
  res.json(await svc.deleteEvent(eventIdOf(req), req.userId));
}));
