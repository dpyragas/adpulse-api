import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { prisma } from './prisma.js';

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  basePath: '/api/auth',
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3001',
  secret: process.env.BETTER_AUTH_SECRET,
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    },
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ['google'],
    },
  },
  session: {
    expiresIn: 60 * 60 * 24, // 24 hours
    updateAge: 60 * 60, // 1 hour
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 min
    },
  },
  trustedOrigins: [process.env.FRONTEND_URL || 'http://localhost:3000'],
  rateLimit: {
    window: 60,
    max: 100,
    customRules: {
      '/sign-in/email': {
        window: 900, // 15 minutes
        max: 5,
      },
    },
  },
});
