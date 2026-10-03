export {};

declare global {
  namespace Express {
    interface Request {
      userId: string;
      userEmail: string;
      requestId: string;
      fileRow?: import('../modules/files/files.service').FileRecord;
      eventCtx?: import('../modules/events/access/types').EventContext;
    }
  }
}
