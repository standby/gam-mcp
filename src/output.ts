import { createReadStream, existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

export type SchemaField = { name: string; type: 'string' | 'number' | 'date' };

export type OutputEnvelope = {
  summary: string;
  row_count: number;
  schema: SchemaField[];
  rows?: Record<string, string>[];
  file_path?: string;
  preview_rows?: Record<string, string>[];
  warnings?: string[];
};

export type OutputManager = {
  fromCsvGzFile: (path: string, summary: string, warnings?: string[]) => Promise<OutputEnvelope>;
  fromInlineRows: (
    rows: Record<string, string>[],
    summary: string,
    schema?: SchemaField[],
  ) => OutputEnvelope;
  cleanup: () => void;
  tempDir: string;
};

export function createOutputManager(opts: {
  tempDir: string;
  inlineThreshold: number;
  previewLimit?: number;
}): OutputManager {
  if (!existsSync(opts.tempDir)) mkdirSync(opts.tempDir, { recursive: true });
  const previewLimit = opts.previewLimit ?? 50;

  return {
    tempDir: opts.tempDir,

    async fromCsvGzFile(path, summary, warnings) {
      const { header, rows } = await readCsvGz(path);
      const schema: SchemaField[] = header.map((name) => ({ name, type: 'string' }));
      if (rows.length <= opts.inlineThreshold) {
        try { unlinkSync(path); } catch { /* ignore */ }
        return { summary, row_count: rows.length, schema, rows, ...(warnings && { warnings }) };
      }
      return {
        summary,
        row_count: rows.length,
        schema,
        file_path: path,
        preview_rows: rows.slice(0, previewLimit),
        ...(warnings && { warnings }),
      };
    },

    fromInlineRows(rows, summary, schema) {
      const inferred = schema ?? (rows[0]
        ? Object.keys(rows[0]).map((name) => ({ name, type: 'string' as const }))
        : []);
      return { summary, row_count: rows.length, schema: inferred, rows };
    },

    cleanup() {
      rmSync(opts.tempDir, { recursive: true, force: true });
    },
  };
}

export async function readCsvGz(path: string): Promise<{ header: string[]; rows: Record<string, string>[] }> {
  const stream = createReadStream(path).pipe(createGunzip());
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const rows: Record<string, string>[] = [];
  let header: string[] = [];
  let lineNo = 0;
  for await (const line of rl) {
    if (lineNo === 0) {
      header = parseCsvLine(line);
    } else if (line.length > 0) {
      const fields = parseCsvLine(line);
      const row: Record<string, string> = {};
      header.forEach((h, i) => { row[h] = fields[i] ?? ''; });
      rows.push(row);
    }
    lineNo++;
  }
  return { header, rows };
}

function parseCsvLine(line: string): string[] {
  // Minimal RFC 4180 parser: handles quoted fields with embedded commas + escaped quotes.
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}
