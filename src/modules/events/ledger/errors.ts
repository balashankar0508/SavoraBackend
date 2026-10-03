import { HttpError } from '../../../lib/httpError';

/** Raised by ledger functions. Extends HttpError (a plain class, no Express
 * dependency) so the shared error handler turns it into a JSON response. */
export class LedgerError extends HttpError {
  constructor(code: string, status = 400) {
    super(status, code);
    this.name = 'LedgerError';
  }
}
