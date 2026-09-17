import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const sources = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f.replaceAll('\\', '/'), text: readFileSync(join(SRC, f), 'utf8') }));

describe('structure', () => {
  it('H4: only report-exec polls report operations (usage.ts only wraps the client)', () => {
    const callers = sources.filter((s) => /\.pollOperation\(/.test(s.text)).map((s) => s.file).sort();
    expect(callers).toEqual(['report-exec.ts', 'usage.ts']);
  });

  it('nothing writes report rows to disk any more', () => {
    expect(existsSync(join(SRC, 'output.ts'))).toBe(false);
    const hits = sources.filter((s) => /downloadReport|fromCsvGzFile|file_path|readCsvGz/.test(s.text)).map((s) => s.file);
    expect(hits).toEqual([]);
  });
});
