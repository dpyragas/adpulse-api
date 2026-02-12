const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

function getLevel(): LogLevel {
  const env = process.env.LOG_LEVEL as LogLevel | undefined;
  if (env && LOG_LEVELS.includes(env)) return env;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(getLevel());
}

function formatMessage(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const entry = {
    level,
    timestamp: new Date().toISOString(),
    message,
    ...(meta && { ...meta }),
  };

  if (process.env.NODE_ENV === 'production') {
    return JSON.stringify(entry);
  }
  return `[${entry.timestamp}] ${level.toUpperCase()}: ${message}${meta ? ' ' + JSON.stringify(meta) : ''}`;
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>) {
    if (shouldLog('debug')) console.debug(formatMessage('debug', message, meta));
  },
  info(message: string, meta?: Record<string, unknown>) {
    if (shouldLog('info')) console.info(formatMessage('info', message, meta));
  },
  warn(message: string, meta?: Record<string, unknown>) {
    if (shouldLog('warn')) console.warn(formatMessage('warn', message, meta));
  },
  error(message: string, meta?: Record<string, unknown>) {
    if (shouldLog('error')) console.error(formatMessage('error', message, meta));
  },
};
