import Anthropic from '@anthropic-ai/sdk';
import { pool } from '../../db/pool';
import { env } from '../../config/env';
import { HttpError } from '../../lib/httpError';
import { logger } from '../../lib/logger';
import { AI_DAILY_LIMIT, SubscriptionTier } from '../../types/shared';

const RECEIPT_PROMPT = `You are extracting structured data from an Indian UPI payment receipt screenshot (Google Pay, PhonePe, Paytm, BHIM, etc).

Return ONLY a single JSON object — no markdown, no commentary — with this shape (omit a field entirely if you cannot find it):
{
  "amount": number,
  "merchantName": string,
  "date": "YYYY-MM-DD",
  "time": "h:mm AM/PM",
  "upiId": string,
  "utr": string,
  "transactionId": string,
  "status": string,
  "type": "expense" | "income"
}

Rules:
- "type" is "income" when the screenshot shows money received ("Received from", credited), "expense" when paid/sent/debited.
- "amount" is a plain JSON number — no currency symbol, no thousands separators (e.g. 1234.56, not "₹1,234.56").
- Convert any date shown into YYYY-MM-DD.
- Convert any time shown into 12-hour "h:mm AM/PM" (e.g. "10:25 AM", "9:05 PM") — never 24-hour, never with seconds.`;

// Optional -- only set up if ANTHROPIC_API_KEY is configured. Used as a
// fallback when Gemini is overloaded, not as the primary path.
const anthropic = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;

async function fetchTier(userId: string): Promise<SubscriptionTier> {
  const { rows } = await pool.query<{ tier: SubscriptionTier }>(
    'select tier from subscriptions where user_id = $1',
    [userId],
  );
  return rows[0]?.tier ?? 'free';
}

async function tryConsumeAiQuota(userId: string, dailyLimit: number): Promise<boolean> {
  const { rows } = await pool.query<{ try_consume_ai_quota: boolean }>(
    'select try_consume_ai_quota($1, $2) as try_consume_ai_quota',
    [userId, dailyLimit],
  );
  return rows[0]?.try_consume_ai_quota ?? false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseJsonResponse(text: string | undefined): Record<string, unknown> {
  if (!text) throw new HttpError(502, 'ai_empty_response');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, 'ai_parse_failed');
  }
}

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

/** Gemini occasionally 503s with "high demand, try again later" -- that's
 * transient overload on Google's side, not a real failure, so it's worth a
 * couple of retries with backoff before giving up (the daily quota was
 * already consumed once, up front, so retrying here doesn't double-charge
 * it). Google's own error message suggests waiting ~1 minute, so the
 * backoff is longer than a single quick retry. */
async function callGeminiWithRetry(body: unknown): Promise<Response> {
  const delaysMs = [3000, 8000];
  for (let attempt = 1; attempt <= delaysMs.length + 1; attempt++) {
    const res = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status !== 503 || attempt > delaysMs.length) return res;
    logger.warn({ attempt }, 'Gemini 503 (high demand) -- retrying');
    await sleep(delaysMs[attempt - 1]);
  }
  /* istanbul ignore next -- unreachable, loop always returns */
  throw new Error('unreachable');
}

async function parseWithGemini(image: string, mimeType: string): Promise<Record<string, unknown>> {
  const geminiRes = await callGeminiWithRetry({
    contents: [
      {
        parts: [
          { text: RECEIPT_PROMPT },
          { inline_data: { mime_type: mimeType, data: image } },
        ],
      },
    ],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });

  if (!geminiRes.ok) {
    logger.error(
      { status: geminiRes.status, body: await geminiRes.text().catch(() => '<unreadable>') },
      'Gemini receipt-parse request failed',
    );
    throw new HttpError(502, 'ai_request_failed');
  }

  const geminiJson = (await geminiRes.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return parseJsonResponse(geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text);
}

async function parseWithClaude(image: string, mimeType: string): Promise<Record<string, unknown>> {
  const message = await anthropic!.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType as 'image/jpeg', data: image },
          },
          { type: 'text', text: RECEIPT_PROMPT },
        ],
      },
    ],
  });

  const text = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
  return parseJsonResponse(text);
}

export async function parseReceipt(
  userId: string,
  image: string,
  mimeType: string,
): Promise<Record<string, unknown>> {
  const tier = await fetchTier(userId);
  const limit = AI_DAILY_LIMIT[tier] ?? 0;

  const allowed = await tryConsumeAiQuota(userId, limit);
  if (!allowed) throw new HttpError(403, 'quota_exceeded');

  try {
    return await parseWithGemini(image, mimeType);
  } catch (geminiErr) {
    if (!anthropic) throw geminiErr;

    logger.warn('Gemini failed -- falling back to Claude Haiku 4.5');
    try {
      return await parseWithClaude(image, mimeType);
    } catch (claudeErr) {
      logger.error({ claudeErr }, 'Claude fallback also failed');
      throw geminiErr;
    }
  }
}
