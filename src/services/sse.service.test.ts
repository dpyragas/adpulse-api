import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Response } from 'express';
import {
  addClient,
  removeClient,
  sendProgress,
  sendComplete,
  sendError,
  _getClientCount,
  _clearAll,
} from './sse.service.js';

interface MockResponse {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  _emit: (event: string) => void;
}

function createMockResponse(): MockResponse {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    _emit: (event: string) => handlers[event]?.forEach((h) => h()),
  };
}

beforeEach(() => {
  _clearAll();
});

describe('sse.service', () => {
  describe('addClient / removeClient', () => {
    it('addClient increments client count', () => {
      const res = createMockResponse();
      addClient('a1', res as unknown as Response);
      expect(_getClientCount('a1')).toBe(1);
    });

    it('addClient registers close handler', () => {
      const res = createMockResponse();
      addClient('a1', res as unknown as Response);
      expect(res.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('removeClient decrements client count', () => {
      const res = createMockResponse();
      addClient('a1', res as unknown as Response);
      removeClient('a1', res as unknown as Response);
      expect(_getClientCount('a1')).toBe(0);
    });

    it('client close event auto-removes from map', () => {
      const res = createMockResponse();
      addClient('a1', res as unknown as Response);
      expect(_getClientCount('a1')).toBe(1);
      res._emit('close');
      expect(_getClientCount('a1')).toBe(0);
    });

    it('removeClient on unknown analysisId is safe', () => {
      const res = createMockResponse();
      expect(() => removeClient('unknown', res as unknown as Response)).not.toThrow();
    });

    it('multiple clients for same analysisId', () => {
      const r1 = createMockResponse();
      const r2 = createMockResponse();
      addClient('a1', r1 as unknown as Response);
      addClient('a1', r2 as unknown as Response);
      expect(_getClientCount('a1')).toBe(2);
    });
  });

  describe('sendProgress', () => {
    it('sends correct SSE format to connected client', () => {
      const res = createMockResponse();
      addClient('a1', res as unknown as Response);
      sendProgress('a1', 1, 'Predicting attention...', 0.33);

      expect(res.write).toHaveBeenCalledWith(
        'event: progress\ndata: {"stage":1,"label":"Predicting attention...","progress":0.33}\n\n'
      );
    });

    it('broadcasts to all connected clients', () => {
      const r1 = createMockResponse();
      const r2 = createMockResponse();
      addClient('a1', r1 as unknown as Response);
      addClient('a1', r2 as unknown as Response);
      sendProgress('a1', 2, 'Detecting elements...', 0.66);

      expect(r1.write).toHaveBeenCalledOnce();
      expect(r2.write).toHaveBeenCalledOnce();
    });

    it('no-op when no clients connected', () => {
      expect(() => sendProgress('nonexistent', 1, 'Test', 0.5)).not.toThrow();
    });
  });

  describe('sendComplete', () => {
    it('sends complete event and ends all responses', () => {
      const res = createMockResponse();
      addClient('a1', res as unknown as Response);
      sendComplete('a1');

      expect(res.write).toHaveBeenCalledWith(
        'event: complete\ndata: {"analysisId":"a1"}\n\n'
      );
      expect(res.end).toHaveBeenCalled();
      expect(_getClientCount('a1')).toBe(0);
    });

    it('ends all clients and clears map', () => {
      const r1 = createMockResponse();
      const r2 = createMockResponse();
      addClient('a1', r1 as unknown as Response);
      addClient('a1', r2 as unknown as Response);
      sendComplete('a1');

      expect(r1.end).toHaveBeenCalled();
      expect(r2.end).toHaveBeenCalled();
      expect(_getClientCount('a1')).toBe(0);
    });
  });

  describe('sendError', () => {
    it('sends error event and ends all responses', () => {
      const res = createMockResponse();
      addClient('a1', res as unknown as Response);
      sendError('a1', 'PROCESSING_FAILED', 'ML pipeline timeout');

      expect(res.write).toHaveBeenCalledWith(
        'event: error\ndata: {"code":"PROCESSING_FAILED","message":"ML pipeline timeout"}\n\n'
      );
      expect(res.end).toHaveBeenCalled();
      expect(_getClientCount('a1')).toBe(0);
    });
  });

  describe('error resilience', () => {
    it('res.write throws → client removed, others unaffected', () => {
      const bad = createMockResponse();
      const good = createMockResponse();
      bad.write.mockImplementation(() => { throw new Error('broken pipe'); });

      addClient('a1', bad as unknown as Response);
      addClient('a1', good as unknown as Response);

      sendProgress('a1', 1, 'Test', 0.5);

      expect(good.write).toHaveBeenCalledOnce();
      expect(_getClientCount('a1')).toBe(1);
    });

    it('res.end throws during endAll → does not crash', () => {
      const res = createMockResponse();
      res.end.mockImplementation(() => { throw new Error('already closed'); });

      addClient('a1', res as unknown as Response);
      expect(() => sendComplete('a1')).not.toThrow();
      expect(_getClientCount('a1')).toBe(0);
    });
  });
});
