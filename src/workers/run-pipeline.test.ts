import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PipelineResponse, SumResponse } from '../types/ml.js';

vi.mock('../services/s3.service.js', () => ({
  downloadImage: vi.fn(),
  uploadBuffer: vi.fn(),
}));

vi.mock('../services/modal.service.js', () => ({
  callPipelineEndpoint: vi.fn(),
  callSumEndpoint: vi.fn(),
  getConditionForPlatform: vi.fn(),
}));

import { runPipeline } from './analysis.worker.js';
import { downloadImage, uploadBuffer } from '../services/s3.service.js';
import { callPipelineEndpoint, callSumEndpoint, getConditionForPlatform } from '../services/modal.service.js';

const mockPipelineResponse: PipelineResponse = {
  image_size: { width: 1080, height: 1080 },
  aois: {
    branding: { found: true, bbox: [10, 20, 100, 80], confidence: 0.85 },
  },
  aesthetic_score: 7.2,
  processing_time_ms: 3400,
};

const mockSumResponse: SumResponse = {
  heatmap: Buffer.from('heatmap-png').toString('base64'),
  overlay: Buffer.from('overlay-png').toString('base64'),
  grayscale: Buffer.from('grayscale-png').toString('base64'),
  condition: 2,
  condition_name: 'E-Commerce',
  original_size: [1080, 1080],
};

const body = { analysisId: 'test-id', imageUrl: 's3://bucket/key', platform: 'META' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(downloadImage).mockResolvedValue(Buffer.from('fake-image'));
  vi.mocked(getConditionForPlatform).mockReturnValue(2);
  vi.mocked(uploadBuffer).mockImplementation(async (_buf, key) => key);
});

describe('runPipeline — retry logic (AC #5)', () => {
  it('retries pipeline once on first failure then succeeds', async () => {
    vi.mocked(callPipelineEndpoint)
      .mockRejectedValueOnce(new Error('cold start'))
      .mockResolvedValueOnce(mockPipelineResponse);
    vi.mocked(callSumEndpoint).mockResolvedValue(mockSumResponse);

    const result = JSON.parse(JSON.stringify(await runPipeline(body)));

    expect(result.pipelineStatus.pipeline).toBe('success');
    expect(result.pipelineStatus.sum).toBe('success');
    expect(callPipelineEndpoint).toHaveBeenCalledTimes(2); // initial + retry
  });

  it('retries SUM once on first failure then succeeds', async () => {
    vi.mocked(callPipelineEndpoint).mockResolvedValue(mockPipelineResponse);
    vi.mocked(callSumEndpoint)
      .mockRejectedValueOnce(new Error('cold start'))
      .mockResolvedValueOnce(mockSumResponse);

    const result = JSON.parse(JSON.stringify(await runPipeline(body)));

    expect(result.pipelineStatus.sum).toBe('success');
    expect(callSumEndpoint).toHaveBeenCalledTimes(2);
  });
});

describe('runPipeline — partial failure (AC #5)', () => {
  it('completes with partial data when pipeline fails after retry', async () => {
    vi.mocked(callPipelineEndpoint).mockRejectedValue(new Error('permanently down'));
    vi.mocked(callSumEndpoint).mockResolvedValue(mockSumResponse);

    const result = JSON.parse(JSON.stringify(await runPipeline(body)));

    expect(result.pipelineStatus.pipeline).toBe('failed');
    expect(result.pipelineStatus.sum).toBe('success');
    expect(result.aois).toBeNull();
    expect(result.aestheticScore).toBeNull();
    expect(result.heatmaps).not.toBeNull();
    expect(result.imageSize).toBeNull();
  });

  it('completes with partial data when SUM fails after retry', async () => {
    vi.mocked(callPipelineEndpoint).mockResolvedValue(mockPipelineResponse);
    vi.mocked(callSumEndpoint).mockRejectedValue(new Error('permanently down'));

    const result = JSON.parse(JSON.stringify(await runPipeline(body)));

    expect(result.pipelineStatus.pipeline).toBe('success');
    expect(result.pipelineStatus.sum).toBe('failed');
    expect(result.aois).not.toBeNull();
    expect(result.heatmaps).toBeNull();
  });
});

describe('runPipeline — total failure (AC #6)', () => {
  it('throws MODAL_BOTH_FAILED when both endpoints fail after retry', async () => {
    vi.mocked(callPipelineEndpoint).mockRejectedValue(new Error('down'));
    vi.mocked(callSumEndpoint).mockRejectedValue(new Error('down'));

    await expect(runPipeline(body))
      .rejects.toMatchObject({ code: 'MODAL_BOTH_FAILED' });
  });
});

describe('runPipeline — heatmap upload (AC #3)', () => {
  it('uploads 3 heatmap PNGs to S3 when SUM succeeds', async () => {
    vi.mocked(callPipelineEndpoint).mockResolvedValue(mockPipelineResponse);
    vi.mocked(callSumEndpoint).mockResolvedValue(mockSumResponse);

    const result = JSON.parse(JSON.stringify(await runPipeline(body)));

    expect(uploadBuffer).toHaveBeenCalledTimes(3);
    expect(result.heatmaps.heatmap).toContain('heatmap.png');
    expect(result.heatmaps.overlay).toContain('overlay.png');
    expect(result.heatmaps.grayscale).toContain('grayscale.png');
  });

  it('throws S3_UPLOAD_FAILED when heatmap upload fails', async () => {
    vi.mocked(callPipelineEndpoint).mockResolvedValue(mockPipelineResponse);
    vi.mocked(callSumEndpoint).mockResolvedValue(mockSumResponse);
    vi.mocked(uploadBuffer).mockRejectedValue(new Error('S3 error'));

    await expect(runPipeline(body))
      .rejects.toMatchObject({ code: 'S3_UPLOAD_FAILED' });
  });
});
