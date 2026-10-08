import { createHash, randomUUID } from 'crypto';
import { pool } from '../../db/pool';
import { env } from '../../config/env';
import { HttpError } from '../../lib/httpError';
import { LocalDiskDriver, StorageDriver } from './storage';
import { sanitizeImage } from './sanitize';
import { sniffImage } from './sniff';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export type FilePurpose = 'receipt' | 'proof' | 'chat';

export interface FileRecord {
  id: string;
  owner_id: string;
  event_id: string;
  purpose: FilePurpose;
  storage_key: string;
  mime: string;
  size_bytes: number;
  created_at: string;
}

export const storage: StorageDriver = new LocalDiskDriver(env.UPLOAD_DIR);

const eventPrefix = (eventId: string) => `events/${eventId}`;

/** Validates the bytes and stores them. The caller has already authorised the upload. */
export async function saveFile(input: {
  eventId: string;
  ownerId: string;
  purpose: FilePurpose;
  buffer: Buffer;
}): Promise<FileRecord> {
  if (!input.buffer.length) throw new HttpError(400, 'file_required');
  if (input.buffer.length > MAX_FILE_BYTES) throw new HttpError(413, 'file_too_large');
  const kind = sniffImage(input.buffer);
  if (!kind) throw new HttpError(415, 'unsupported_file_type');
  // only the re-encoded pixels are kept: no GPS location or other metadata reaches other members
  const clean = await sanitizeImage(input.buffer, kind);

  const id = randomUUID();
  const key = `${eventPrefix(input.eventId)}/${id}.${kind.ext}`;
  await storage.put(key, clean);
  try {
    const { rows } = await pool.query<FileRecord>(
      `insert into files (id, owner_id, event_id, purpose, storage_key, mime, size_bytes, sha256)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, owner_id, event_id, purpose, storage_key, mime, size_bytes, created_at`,
      [id, input.ownerId, input.eventId, input.purpose, key, kind.mime, clean.length,
        createHash('sha256').update(clean).digest('hex')],
    );
    return rows[0];
  } catch (err) {
    await storage.remove(key).catch(() => undefined); // don't leave an orphan if the insert fails
    throw err;
  }
}

export async function findFile(fileId: string): Promise<FileRecord | null> {
  const { rows } = await pool.query<FileRecord>(
    `select id, owner_id, event_id, purpose, storage_key, mime, size_bytes, created_at
       from files where id = $1`,
    [fileId],
  );
  return rows[0] ?? null;
}

/**
 * For services that attach an uploaded file to an expense/settlement/message:
 * the file must exist, belong to THIS event, have been uploaded by the acting
 * user, and have the right purpose. Run inside the event transaction.
 */
export async function assertFileAttachable(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  fileId: string,
  eventId: string,
  userId: string,
  purpose: FilePurpose,
): Promise<void> {
  const { rows } = await client.query(
    'select 1 from files where id = $1 and event_id = $2 and owner_id = $3 and purpose = $4',
    [fileId, eventId, userId, purpose],
  );
  if (!rows[0]) throw new HttpError(400, 'invalid_file');
}

/** Removes every stored file of an event. Called after the event row is deleted
 * (DB rows go with it via ON DELETE CASCADE). */
export async function deleteEventFiles(eventId: string): Promise<void> {
  await storage.removePrefix(eventPrefix(eventId));
}
