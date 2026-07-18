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

export async function sendResetEmail(email: string, deepLink: string): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    console.log(`[dev mailer] Reset link for ${email}: ${deepLink}`);
  }

  const html = layout(`
    <h1 style="margin:0 0 8px;font-size:20px;">Reset your password</h1>
    <p style="margin:0 0 24px;font-size:14px;color:${COLORS.inkMuted};line-height:1.5;">
      Tap the button below on your phone to choose a new password for your Spenxo account.
    </p>
    <div style="text-align:center;margin:0 0 24px;">
      <a href="${deepLink}" style="display:inline-block;background:${COLORS.accent};color:#FFFFFF;font-size:15px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:6px;">
        Reset password
      </a>
    </div>
    <p style="margin:0 0 12px;font-size:13px;color:${COLORS.inkMuted};line-height:1.5;">
      Button not working? Copy this link into your phone's browser:<br />
      <span style="word-break:break-all;color:${COLORS.accent};">${deepLink}</span>
    </p>
    <p style="margin:0;font-size:13px;color:${COLORS.inkMuted};line-height:1.5;">
      This link expires in 30 minutes. If you didn't request this, you can safely ignore this email.
    </p>
  `);

  await send({
    to: email,
    subject: 'Reset your Spenxo password',
    text: `Tap this link on your phone to reset your password: ${deepLink}\n\nThis link expires in 30 minutes. If you didn't request this, ignore this email.`,
    html,
  });
}
