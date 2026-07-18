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
  "time": string,
  "upiId": string,
  "utr": string,
  "transactionId": string,
  "status": string,
  "type": "expense" | "income"
}

Rules:
- "type" is "income" when the screenshot shows money received ("Received from", credited), "expense" when paid/sent/debited.
- "amount" is the actual transaction amount only — never a phone number, account suffix, or reference number digit string.
- Convert any date shown into YYYY-MM-DD.`;

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

export async function parseReceipt(
  userId: string,
  image: string,
  mimeType: string,
): Promise<Record<string, unknown>> {
  const tier = await fetchTier(userId);
  const limit = AI_DAILY_LIMIT[tier] ?? 0;

  const allowed = await tryConsumeAiQuota(userId, limit);
  if (!allowed) throw new HttpError(403, 'quota_exceeded');

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: RECEIPT_PROMPT },
              { inline_data: { mime_type: mimeType, data: image } },
            ],
          },
        ],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    },
  );

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
  const text = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new HttpError(502, 'ai_empty_response');

  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, 'ai_parse_failed');
  }
}
