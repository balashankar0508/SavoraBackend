import { env } from '../config/env';

function parseMailFrom(mailFrom: string): { email: string; name?: string } {
  const match = mailFrom.match(/^"?([^"<]*)"?\s*<(.+)>$/);
  if (match) {
    const name = match[1].trim();
    return name ? { name, email: match[2].trim() } : { email: match[2].trim() };
  }
  return { email: mailFrom.trim() };
}

async function send(params: { to: string; subject: string; text: string }): Promise<void> {
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
  await send({
    to: email,
    subject: 'Your Savora verification code',
    text: `Your verification code is ${code}. It expires in 15 minutes.`,
  });
}

export async function sendResetEmail(email: string, deepLink: string): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    console.log(`[dev mailer] Reset link for ${email}: ${deepLink}`);
  }
  await send({
    to: email,
    subject: 'Reset your Savora password',
    text: `Tap this link on your phone to reset your password: ${deepLink}\n\nThis link expires in 30 minutes. If you didn't request this, ignore this email.`,
  });
}
