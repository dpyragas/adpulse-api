import { describe, it, expect } from 'vitest';
import { auth } from './auth.js';

describe('Better Auth instance', () => {
  it('exports auth with expected API methods', () => {
    expect(auth).toBeDefined();
    expect(auth.api).toBeDefined();
    expect(auth.api.getSession).toBeTypeOf('function');
  });
});
