import express from 'express';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './lib/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { healthRouter } from './routes/health.routes.js';
import { usersRouter } from './routes/users.routes.js';
import { historyRouter } from './routes/history.routes.js';
import { reportRouter } from './routes/reports.routes.js';
import { analysisRouter } from './routes/analysis.routes.js';

const app = express();

// 1. CORS
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  })
);

// 2. Better Auth handler — BEFORE express.json()
app.all('/api/auth/*splat', toNodeHandler(auth));

// 3. Body parser — AFTER auth handler
app.use(express.json());

// 4. Rate limiting (added in Task 8)

// 5. Routes
app.use('/api', healthRouter);
app.use('/api', usersRouter);
app.use('/api', historyRouter);
app.use('/api', reportRouter);
app.use('/api', analysisRouter);

// Global error handler (must be last)
app.use(errorHandler);

export { app };
