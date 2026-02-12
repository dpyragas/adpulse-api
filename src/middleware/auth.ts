import type { Request, Response, NextFunction } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/app-error.js';

function extractSessionToken(cookieHeader: string): string | null {
  const match = cookieHeader.match(/better-auth\.session_token=([^;]+)/);
  if (!match) return null;
  return decodeURIComponent(match[1]);
}

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!session) {
    // Differentiate expired session from missing session
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      const token = extractSessionToken(cookieHeader);
      if (token) {
        const dbSession = await prisma.session.findFirst({ where: { token } });
        if (dbSession && dbSession.expiresAt < new Date()) {
          throw new AppError('SESSION_EXPIRED', 401, 'Session has expired');
        }
      }
    }
    throw new AppError('UNAUTHORIZED', 401, 'Authentication required');
  }

  req.user = session.user;
  req.session = session.session;
  next();
}
