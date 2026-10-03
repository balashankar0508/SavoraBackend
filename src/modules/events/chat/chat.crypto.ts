import { decryptGcm, encryptGcm } from '../../../lib/secretBox';

/**
 * Chat bodies are encrypted at rest with AES-256-GCM using the server key
 * (CHAT_ENCRYPTION_KEY). This is protection of stored data, NOT end-to-end
 * encryption: the server can decrypt, and the UI must not claim otherwise.
 *
 * The event id AND the message id are authenticated as AAD, so a ciphertext
 * copied into another event, or swapped with another message, fails to decrypt.
 */
export const CHAT_KEY_VERSION = 1;
const LABEL = 'chat';

export type ChatContent = { text: string } | { caption: string };

const aad = (eventId: string, messageId: string) => `chat:${eventId}:${messageId}`;

export function encryptChat(keyHex: string, eventId: string, messageId: string, content: ChatContent) {
  const { iv, data } = encryptGcm(keyHex, LABEL, JSON.stringify(content), aad(eventId, messageId));
  return { ciphertext: data, iv, key_version: CHAT_KEY_VERSION };
}

/** Throws if the key, event, message id, iv or ciphertext do not match what was encrypted. */
export function decryptChat(keyHex: string, eventId: string, messageId: string, ciphertext: Buffer, iv: Buffer): ChatContent {
  const plain = decryptGcm(keyHex, LABEL, iv, ciphertext, aad(eventId, messageId)).toString('utf8');
  return JSON.parse(plain) as ChatContent;
}
