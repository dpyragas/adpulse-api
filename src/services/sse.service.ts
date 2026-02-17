import type { Response } from 'express';
import { logger } from '../lib/logger.js';

const clients = new Map<string, Set<Response>>();

export function addClient(analysisId: string, res: Response): void {
  if (!clients.has(analysisId)) clients.set(analysisId, new Set());
  clients.get(analysisId)!.add(res);

  res.on('close', () => {
    removeClient(analysisId, res);
  });

  logger.debug('SSE client added', { analysisId, count: clients.get(analysisId)!.size });
}

export function removeClient(analysisId: string, res: Response): void {
  const set = clients.get(analysisId);
  if (set) {
    set.delete(res);
    if (set.size === 0) clients.delete(analysisId);
  }
}

function broadcast(analysisId: string, event: string, data: Record<string, unknown>): void {
  const set = clients.get(analysisId);
  if (!set || set.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...set]) {
    try {
      res.write(payload);
    } catch (err) {
      logger.warn('SSE write failed, removing client', { analysisId, error: String(err) });
      removeClient(analysisId, res);
    }
  }
}

export function sendProgress(analysisId: string, stage: number, label: string, progress: number): void {
  broadcast(analysisId, 'progress', { stage, label, progress });
}

export function sendComplete(analysisId: string): void {
  broadcast(analysisId, 'complete', { analysisId });
  endAll(analysisId);
}

export function sendError(analysisId: string, code: string, message: string): void {
  broadcast(analysisId, 'error', { code, message });
  endAll(analysisId);
}

function endAll(analysisId: string): void {
  const set = clients.get(analysisId);
  if (!set) return;
  for (const res of set) {
    try { res.end(); } catch { /* already closed */ }
  }
  clients.delete(analysisId);
}

// Exported for testing only
export function _getClientCount(analysisId: string): number {
  return clients.get(analysisId)?.size ?? 0;
}

export function _clearAll(): void {
  clients.clear();
}
