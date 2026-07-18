import { Request, Response } from 'express';
import * as service from './auth.service';
import * as schemas from './auth.schemas';

export async function registerHandler(req: Request, res: Response) {
  const { name, email, password } = schemas.registerSchema.parse(req.body);
  const result = await service.register(name, email, password);
  res.status(201).json(result);
}

export async function verifyEmailHandler(req: Request, res: Response) {
  const { email, code } = schemas.verifyEmailSchema.parse(req.body);
  const result = await service.verifyEmail(email, code);
  res.json(result);
}

export async function resendVerificationHandler(req: Request, res: Response) {
  const { email } = schemas.resendVerificationSchema.parse(req.body);
  await service.resendVerification(email);
  res.json({ ok: true });
}

export async function loginHandler(req: Request, res: Response) {
  const { email, password } = schemas.loginSchema.parse(req.body);
  const result = await service.login(email, password);
  res.json(result);
}

export async function refreshHandler(req: Request, res: Response) {
  const { refreshToken } = schemas.refreshSchema.parse(req.body);
  const tokens = await service.refresh(refreshToken);
  res.json(tokens);
}

export async function logoutHandler(req: Request, res: Response) {
  const { refreshToken } = schemas.logoutSchema.parse(req.body);
  await service.logout(refreshToken);
  res.json({ ok: true });
}

export async function forgotPasswordHandler(req: Request, res: Response) {
  const { email } = schemas.forgotPasswordSchema.parse(req.body);
  await service.forgotPassword(email);
  res.json({ ok: true });
}

export async function resetPasswordHandler(req: Request, res: Response) {
  const { token, newPassword } = schemas.resetPasswordSchema.parse(req.body);
  const result = await service.resetPassword(token, newPassword);
  res.json(result);
}

export async function updateProfileHandler(req: Request, res: Response) {
  const { name } = schemas.updateProfileSchema.parse(req.body);
  const user = await service.updateProfile(req.userId, name);
  res.json({ user });
}

export async function meHandler(req: Request, res: Response) {
  const result = await service.me(req.userId);
  res.json(result);
}
