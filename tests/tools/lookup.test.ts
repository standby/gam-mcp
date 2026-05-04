import { describe, it, expect } from 'vitest';
import { lookupTool } from '../../src/tools/lookup.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ctx = () => {
  const dir = mkdtempSync(join(tmpdir(), 'lkp-'));
  return {
    dir,
    ctx: {
      client: createMockGamClient({
        entities: {
          advertiser: [
            { id: 1, name: 'Acme Corp' },
            { id: 2, name: 'Acme Industries' },
            { id: 3, name: 'Beta Inc' },
          ],
        },
      }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'America/Los_Angeles',
    },
  };
};

describe('lookup', () => {
  it('returns matches by name substring', async () => {
    const { ctx: c, dir } = ctx();
    const args = lookupTool.input.parse({ entity_type: 'advertiser', query: 'acme' });
    const r = await lookupTool.handler(args, c);
    expect('rows' in r).toBe(true);
    if ('rows' in r) {
      expect(r.rows).toEqual([
        { id: '1', name: 'Acme Corp' },
        { id: '2', name: 'Acme Industries' },
      ]);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns ENTITY_NOT_FOUND on no match', async () => {
    const { ctx: c, dir } = ctx();
    const args = lookupTool.input.parse({ entity_type: 'advertiser', query: 'zzznope' });
    const r = await lookupTool.handler(args, c);
    expect('error' in r).toBe(true);
    if ('error' in r) expect((r.error as { code: string }).code).toBe('ENTITY_NOT_FOUND');
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists all (up to limit) when neither query nor ids is provided', async () => {
    const { ctx: c, dir } = ctx();
    const args = lookupTool.input.parse({ entity_type: 'advertiser' });
    const r = await lookupTool.handler(args, c);
    expect('rows' in r).toBe(true);
    if ('rows' in r) {
      expect(r.rows).toEqual([
        { id: '1', name: 'Acme Corp' },
        { id: '2', name: 'Acme Industries' },
        { id: '3', name: 'Beta Inc' },
      ]);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
