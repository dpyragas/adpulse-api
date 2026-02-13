import { app } from './app.js';

const REQUIRED_ENV_VARS = ['AWS_REGION', 'S3_BUCKET_NAME'] as const;
for (const v of REQUIRED_ENV_VARS) {
  if (!process.env[v]) throw new Error(`Missing required env var: ${v}`);
}

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
