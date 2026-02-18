import 'dotenv/config';
import { app } from './app.js';
import { logger } from './lib/logger.js';
import { startWorker, stopWorker } from './workers/analysis.worker.js';

const REQUIRED_ENV_VARS = ['AWS_REGION', 'S3_BUCKET_NAME', 'SQS_QUEUE_URL', 'MODAL_PIPELINE_URL', 'MODAL_SUM_URL'] as const;
for (const v of REQUIRED_ENV_VARS) {
  if (!process.env[v]) throw new Error(`Missing required env var: ${v}`);
}

if (!process.env.OPENAI_API_KEY) {
  logger.warn('OPENAI_API_KEY not set — AI insights will be unavailable');
}

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  startWorker();
});

function shutdown() {
  stopWorker();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
