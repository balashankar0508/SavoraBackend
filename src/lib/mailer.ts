import { env } from '../config/env';

function parseMailFrom(mailFrom: string): { email: string; name?: string } {
  const match = mailFrom.match(/^"?([^"<]*)"?\s*<(.+)>$/);
  if (match) {
    const name = match[1].trim();
    return name ? { name, email: match[2].trim() } : { email: match[2].trim() };
  }
  return { email: mailFrom.trim() };
}

const COLORS = {
  bg: '#F2F1EA',
  card: '#FFFFFF',
  border: '#D9D6C9',
  ink: '#1B211F',
  inkMuted: '#5B6360',
  accent: '#2F6F5E',
  accentStrong: '#1F4F42',
  accentTint: '#DCEAE4',
};

function layout(bodyHtml: string): string {
  return `<!doctype html>
<html>
<body style="margin:0;padding:32px 16px;background:${COLORS.bg};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:10px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 0;">
              <div style="font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${COLORS.accentStrong};">Spenxo</div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 32px;color:${COLORS.ink};">
              ${bodyHtml}
            </td>
          </tr>
        </table>
        <p style="max-width:480px;margin:20px 0 0;font-size:12px;color:${COLORS.inkMuted};text-align:center;">
          Spenxo · Your Savings Growth Coach
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function send(params: { to: string; subject: string; text: string; html: string }): Promise<void> {
  if (env.NODE_ENV === 'test') return; // never hit Brevo from tests
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: parseMailFrom(env.MAIL_FROM),
        to: [{ email: params.to }],
        subject: params.subject,
        textContent: params.text,
        htmlContent: params.html,
      }),
    });
    if (!res.ok) {
      throw new Error(`Brevo send failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    // In production a delivery failure should surface (500) so it gets
    // noticed; in local dev the code/link is already logged above, so a
    // missing/placeholder BREVO_API_KEY shouldn't block testing.
    if (env.NODE_ENV === 'production') throw err;
    console.warn('[dev mailer] send failed (ignored outside production):', err);
  }
}

export async function sendOtpEmail(email: string, code: string): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    console.log(`[dev mailer] OTP for ${email}: ${code}`);
  }

  const html = layout(`
    <h1 style="margin:0 0 8px;font-size:20px;">Verify your email</h1>
    <p style="margin:0 0 24px;font-size:14px;color:${COLORS.inkMuted};line-height:1.5;">
      Enter this code in the app to finish signing in to Spenxo.
    </p>
    <div style="background:${COLORS.accentTint};border-radius:8px;padding:20px;text-align:center;margin:0 0 24px;">
      <span style="font-family:'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:10px;color:${COLORS.accentStrong};">${code}</span>
    </div>
    <p style="margin:0;font-size:13px;color:${COLORS.inkMuted};line-height:1.5;">
      This code expires in 15 minutes. If you didn't request this, you can safely ignore this email.
    </p>
  `);

  await send({
    to: email,
    subject: 'Your Spenxo verification code',
    text: `Your verification code is ${code}. It expires in 15 minutes.`,
    html,
  });
}

/**
 * Password reset by a 6-digit code typed into the app. A code (not a link) cannot be caught by
 * another app that registers the same URL scheme, which is how a reset link could be stolen.
 */
export async function sendResetCodeEmail(email: string, code: string): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    console.log(`[dev mailer] Reset code for ${email}: ${code}`);
  }

  const html = layout(`
    <h1 style="margin:0 0 8px;font-size:20px;">Reset your password</h1>
    <p style="margin:0 0 24px;font-size:14px;color:${COLORS.inkMuted};line-height:1.5;">
      Enter this code in the Spenxo app to choose a new password.
    </p>
    <div style="background:${COLORS.accentTint};border-radius:8px;padding:20px;text-align:center;margin:0 0 24px;">
      <span style="font-family:'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:10px;color:${COLORS.accentStrong};">${code}</span>
    </div>
    <p style="margin:0;font-size:13px;color:${COLORS.inkMuted};line-height:1.5;">
      This code expires in 15 minutes. Never share it with anyone: Spenxo will never ask you for it.
      If you didn't request this, you can safely ignore this email.
    </p>
  `);

  await send({
    to: email,
    subject: 'Your Spenxo password reset code',
    text: `Your password reset code is ${code}. It expires in 15 minutes. Never share it with anyone. If you didn't request this, ignore this email.`,
    html,
  });
}

/**
 * Someone tried to sign up with an email that already has an account. The app shows the same
 * "check your email" screen either way (so sign-up cannot be used to find out who has an
 * account); the real owner learns about it here.
 */
export async function sendAccountExistsEmail(email: string): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    console.log(`[dev mailer] Account-exists notice for ${email}`);
  }

  const html = layout(`
    <h1 style="margin:0 0 8px;font-size:20px;">You already have a Spenxo account</h1>
    <p style="margin:0 0 16px;font-size:14px;color:${COLORS.inkMuted};line-height:1.5;">
      Someone just tried to create a new Spenxo account with this email address. Your account already exists, so nothing was changed.
    </p>
    <p style="margin:0;font-size:13px;color:${COLORS.inkMuted};line-height:1.5;">
      If this was you, sign in instead, or use "Forgot password" in the app. If it wasn't you, you can ignore this email.
    </p>
  `);

  await send({
    to: email,
    subject: 'You already have a Spenxo account',
    text: 'Someone just tried to create a new Spenxo account with this email. Your account already exists, so nothing was changed. If this was you, sign in or use "Forgot password" in the app. If not, ignore this email.',
    html,
  });
}

const escapeHtml = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Invitation to join an event. Carries the code (typed into "Join with invite") and a deep link. */
export async function sendEventInviteEmail(
  email: string,
  details: { inviterName: string; eventTitle: string; code: string; deepLink: string },
): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    console.log(`[dev mailer] Event invite for ${email}: ${details.code} ${details.deepLink}`);
  }
  const inviter = escapeHtml(details.inviterName);
  const title = escapeHtml(details.eventTitle);

  const html = layout(`
    <h1 style="margin:0 0 8px;font-size:20px;">You're invited to ${title}</h1>
    <p style="margin:0 0 24px;font-size:14px;color:${COLORS.inkMuted};line-height:1.5;">
      ${inviter} invited you to split expenses for this event on Spenxo.
    </p>
    <div style="background:${COLORS.accentTint};border-radius:8px;padding:20px;text-align:center;margin:0 0 24px;">
      <div style="font-size:12px;color:${COLORS.inkMuted};letter-spacing:0.08em;margin-bottom:8px;">INVITATION CODE</div>
      <span style="font-family:'Courier New',monospace;font-size:26px;font-weight:700;letter-spacing:4px;color:${COLORS.accentStrong};">${escapeHtml(details.code)}</span>
    </div>
    <div style="text-align:center;margin:0 0 24px;">
      <a href="${escapeHtml(details.deepLink)}" style="display:inline-block;background:${COLORS.accent};color:#FFFFFF;font-size:15px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:6px;">
        Open in Spenxo
      </a>
    </div>
    <p style="margin:0;font-size:13px;color:${COLORS.inkMuted};line-height:1.5;">
      In the app, open Events &rarr; Join with invite and enter the code. Sign up with this email address if you don't have an account yet.
      The code expires in 7 days. If you weren't expecting this, you can ignore this email.
    </p>
  `);

  await send({
    to: email,
    subject: `${details.inviterName} invited you to ${details.eventTitle} on Spenxo`,
    text: `${details.inviterName} invited you to "${details.eventTitle}" on Spenxo.

Invitation code: ${details.code}
Open: ${details.deepLink}

In the app: Events > Join with invite. The code expires in 7 days.`,
    html,
  });
}
