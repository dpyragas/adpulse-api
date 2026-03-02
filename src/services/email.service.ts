import nodemailer from 'nodemailer';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';

if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  logger.warn('Missing SMTP env vars (SMTP_HOST, SMTP_USER, SMTP_PASS) — email sending will fail');
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendEmail({
  to,
  subject,
  text,
  html,
}: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'noreply@adpulse.com',
      to,
      subject,
      text,
      html,
    });
    logger.info('Email sent', { to, subject });
  } catch (error) {
    logger.error('Email send failed', { to, subject, error: String(error) });
    throw new AppError('EMAIL_SEND_FAILED', 500, 'Failed to send email');
  }
}
