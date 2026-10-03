import rateLimit from 'express-rate-limit';

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
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
