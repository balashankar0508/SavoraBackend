import { createHash } from 'crypto';
import rateLimit from 'express-rate-limit';

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  // per IP: integration tests come from one address; the per-email and per-token limiters stay on and are tested
  skip: () => process.env.NODE_ENV === 'test',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

const sha = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 32);

// Refresh/logout: keyed by the (hashed) refresh token, not the IP, because thousands of phones
// share one mobile-carrier IP and a per-IP limit would sign real people out.
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => {
    const token = req.body?.refreshToken;
    return typeof token === 'string' && token ? `rt:${sha(token)}` : `ip:${req.ip}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

// Everything that sends or checks an emailed code, keyed by the email (one shared counter),
// so guessing a code cannot be spread over many IP addresses and nobody can flood an inbox.
// 10 per 15 minutes is plenty for a person and makes guessing a 6-digit code hopeless.
export const emailCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => {
    const email = req.body?.email;
    return typeof email === 'string' && email ? `em:${sha(email.trim().toLowerCase())}` : `ip:${req.ip}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

export const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  // integration tests hit the API from one IP far faster than a real client; the
  // per-user limiters (uploads, mutations, join attempts) stay active and are tested
  skip: () => process.env.NODE_ENV === 'test',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

// Keyed by user (requireAuth runs first), not IP: many phones share one carrier-NAT address.
export const eventMutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => req.userId,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_event_changes' },
});

// Guessing invite codes: 10 attempts per 15 minutes per user+IP.
export const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `${req.userId}|${req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_invitation_attempts' },
});

// Keyed by user (requireAuth runs first): 20 uploads per hour.
export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => req.userId,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_uploads' },
});

// Keyed by user: 60 chat messages per minute.
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: (req) => req.userId,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_messages' },
});

// Keyed by user: PDF/CSV generation is CPU-heavy, 20 per minute.
export const reportLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  keyGenerator: (req) => req.userId,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_downloads' },
});
