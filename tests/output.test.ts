import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createOutputManager, type OutputManager } from '../src/output.js';

describe('output manager', () => {
  let workdir: string;
  let mgr: OutputManager;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'gam-mcp-test-'));
    mgr = createOutputManager({ tempDir: workdir, inlineThreshold: 3 });
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  function writeFixtureCsvGz(name: string, csv: string): string {
    const path = join(workdir, name);
    writeFileSync(path, gzipSync(Buffer.from(csv, 'utf8')));
    return path;
  }

  it('returns inline when row count <= threshold', async () => {
    const path = writeFixtureCsvGz(
      'small.csv.gz',
      'advertiser_name,impressions\nAcme,100\nBeta,50\n',
    );
    const out = await mgr.fromCsvGzFile(path, 'Two advertisers');
    expect(out.summary).toBe('Two advertisers');
    expect(out.row_count).toBe(2);
    expect(out.schema).toEqual([
      { name: 'advertiser_name', type: 'string' },
      { name: 'impressions', type: 'string' },
    ]);
    expect(out.rows).toEqual([
      { advertiser_name: 'Acme', impressions: '100' },
      { advertiser_name: 'Beta', impressions: '50' },
    ]);
    expect(out.file_path).toBeUndefined();
    expect(existsSync(path)).toBe(false); // small file deleted
  });

  it('returns file_path + preview when row count > threshold', async () => {
    const csv = 'advertiser_name,impressions\n' +
      Array.from({ length: 5 }, (_, i) => `A${i},${i}`).join('\n') + '\n';
    const path = writeFixtureCsvGz('big.csv.gz', csv);
    const out = await mgr.fromCsvGzFile(path, 'Five rows');
    expect(out.row_count).toBe(5);
    expect(out.rows).toBeUndefined();
    expect(out.file_path).toBe(path);
    expect(out.preview_rows).toHaveLength(5);
    expect(existsSync(path)).toBe(true); // file kept
  });

  it('cleanup deletes temp dir', () => {
    expect(existsSync(workdir)).toBe(true);
    mgr.cleanup();
    expect(existsSync(workdir)).toBe(false);
  });
});
