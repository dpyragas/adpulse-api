import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callPipelineEndpoint, callSumEndpoint, getConditionForPlatform } from './modal.service.js';
import { logger } from '../lib/logger.js';

const validPipelineResponse = {
  image_size: { width: 1080, height: 1080 },
  aois: {
    branding: { found: true, bbox: [10, 20, 100, 80], confidence: 0.85 },
    product: { found: false },
    headline: { found: true, bbox: [50, 200, 500, 260], text: 'Big Sale', confidence: 0.95 },
    cta: { found: true, bbox: [400, 900, 680, 960], text: 'Shop Now', confidence: 0.98 },
    body_text: { found: true, regions: [{ bbox: [50, 300, 500, 400], text: 'Save 50%', confidence: 0.9 }] },
  },
  masks: {
    branding: { shape: [1080, 1080], sum: 15000, rle: { counts: [100, 200], size: [1080, 1080] } },
  },
  aesthetic_score: 7.2,
  processing_time_ms: 3400,
  all_text_regions: [{ bbox: [50, 200, 500, 260], text: 'Big Sale', confidence: 0.95 }],
};

const validSumResponse = {
  heatmap: 'base64heatmap',
  overlay: 'base64overlay',
  grayscale: 'base64grayscale',
  condition: 2,
  condition_name: 'E-Commerce',
  original_size: [1080, 1080] as [number, number],
  inference_stdout: 'inference output',
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callPipelineEndpoint', () => {
  it('sends correct request body with default options', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(validPipelineResponse) });

    await callPipelineEndpoint('base64img');

    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({
      image_base64: 'base64img',
      use_sam_masks: true,
      detect_branding: true,
      detect_product: true,
    });
    expect(call[1].headers['Content-Type']).toBe('application/json');
  });

  it('sends custom options when provided', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(validPipelineResponse) });

    await callPipelineEndpoint('img', { useSamMasks: false, detectBranding: false, detectProduct: false });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.use_sam_masks).toBe(false);
    expect(body.detect_branding).toBe(false);
    expect(body.detect_product).toBe(false);
  });

  it('returns parsed response on success', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(validPipelineResponse) });

    const result = await callPipelineEndpoint('img');
    expect(result.aesthetic_score).toBe(7.2);
    expect(result.aois.branding?.found).toBe(true);
  });

  it('throws MODAL_PIPELINE_FAILED on non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await expect(callPipelineEndpoint('img'))
      .rejects.toMatchObject({ code: 'MODAL_PIPELINE_FAILED', status: 502 });
  });

  it('throws MODAL_PIPELINE_INVALID_RESPONSE on bad JSON', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ bad: 'data' }) });

    await expect(callPipelineEndpoint('img'))
      .rejects.toMatchObject({ code: 'MODAL_PIPELINE_INVALID_RESPONSE' });
  });

  it('throws MODAL_PIPELINE_UNAVAILABLE on fetch error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(callPipelineEndpoint('img'))
      .rejects.toMatchObject({ code: 'MODAL_PIPELINE_UNAVAILABLE', status: 503 });
  });

  it('logs cold start warning when response takes >15s (AC #4)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(validPipelineResponse) });

    const dateNowSpy = vi.spyOn(Date, 'now');
    dateNowSpy.mockReturnValueOnce(0).mockReturnValueOnce(16000);

    await callPipelineEndpoint('img');

    expect(warnSpy).toHaveBeenCalledWith('Pipeline cold start detected', expect.objectContaining({ elapsedMs: expect.any(Number) }));
    warnSpy.mockRestore();
    dateNowSpy.mockRestore();
  });

  it('does not send auth headers', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(validPipelineResponse) });

    await callPipelineEndpoint('img');

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('parses response with sentiment + category fields', async () => {
    const responseWithClassification = {
      ...validPipelineResponse,
      sentiment: { scores: { cheerful: 0.18, excitement: 0.14 } },
      category: { levels: [{ level: 1, label: 'Food', confidence: 0.87 }] },
    };
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(responseWithClassification) });

    const result = await callPipelineEndpoint('img');
    expect(result.sentiment?.scores.cheerful).toBe(0.18);
    expect(result.category?.levels[0].label).toBe('Food');
  });

  it('parses response without sentiment/category (backward compat)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(validPipelineResponse) });

    const result = await callPipelineEndpoint('img');
    expect(result.sentiment).toBeUndefined();
    expect(result.category).toBeUndefined();
  });
});

describe('callSumEndpoint', () => {
  it('sends correct request body', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(validSumResponse) });

    await callSumEndpoint('base64img', 2);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ image_base64: 'base64img', condition: 2 });
  });

  it('returns parsed response on success', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(validSumResponse) });

    const result = await callSumEndpoint('img', 2);
    expect(result.heatmap).toBe('base64heatmap');
    expect(result.condition_name).toBe('E-Commerce');
  });

  it('throws MODAL_SUM_FAILED on non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await expect(callSumEndpoint('img', 2))
      .rejects.toMatchObject({ code: 'MODAL_SUM_FAILED', status: 502 });
  });

  it('throws MODAL_SUM_INVALID_RESPONSE on bad JSON', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ wrong: true }) });

    await expect(callSumEndpoint('img', 2))
      .rejects.toMatchObject({ code: 'MODAL_SUM_INVALID_RESPONSE' });
  });

  it('throws MODAL_SUM_UNAVAILABLE on fetch error', async () => {
    fetchMock.mockRejectedValue(new Error('DNS failure'));

    await expect(callSumEndpoint('img', 1))
      .rejects.toMatchObject({ code: 'MODAL_SUM_UNAVAILABLE', status: 503 });
  });
});

describe('getConditionForPlatform', () => {
  it.each([
    ['META', 2],
    ['TIKTOK', 2],
    ['LINKEDIN', 2],
    ['GENERAL', 1],
  ])('maps %s to condition %d', (platform, expected) => {
    expect(getConditionForPlatform(platform)).toBe(expected);
  });

  it('defaults unknown platforms to 2 (E-Commerce)', () => {
    expect(getConditionForPlatform('UNKNOWN')).toBe(2);
  });
});
