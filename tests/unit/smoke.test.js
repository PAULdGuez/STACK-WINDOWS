import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('Smoke test', () => {
  it('should pass a basic assertion', () => {
    expect(true).toBe(true);
  });

  it('should be able to import mocked electron', async () => {
    const electron = await import('electron');
    expect(electron.app).toBeDefined();
    expect(electron.app.getPath).toBeDefined();
  });

  it('should be able to import mocked koffi', async () => {
    const koffi = await import('koffi');
    expect(koffi.load).toBeDefined();
    expect(koffi.register).toBeDefined();
  });
});
