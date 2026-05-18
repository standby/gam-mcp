import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// Saved-query shape: a run_report-compatible template missing only the
// date_range. Replay always provides a fresh date_range — saving the
// original date is the analyst-mistake we're explicitly preventing.
export type SavedQueryBody = {
  dimensions: string[];
  metrics: string[];
  filters?: { field: string; op: string; value: unknown }[];
  custom_dimension_key_ids?: number[];
};

export type SavedQueryEntry = {
  name: string;
  body: SavedQueryBody;
  description?: string;
  saved_at: string; // ISO timestamp
};

type StoreFile = {
  version: 1;
  queries: Record<string, SavedQueryEntry>;
};

export type SavedQueryStore = {
  save: (name: string, body: SavedQueryBody, description?: string) => SavedQueryEntry;
  get: (name: string) => SavedQueryEntry | null;
  list: () => SavedQueryEntry[];
  delete: (name: string) => boolean;
  path: string;
};

export function defaultSavedQueriesPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GAM_SAVED_QUERIES_FILE) return env.GAM_SAVED_QUERIES_FILE;
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'gam-mcp', 'saved-queries.json');
}

export function createSavedQueryStore(path: string): SavedQueryStore {
  function read(): StoreFile {
    if (!existsSync(path)) return { version: 1, queries: {} };
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed.version !== 1 || typeof parsed.queries !== 'object') {
        throw new Error('unrecognized saved-queries file format');
      }
      return parsed;
    } catch (e) {
      throw new Error(`failed to read saved queries from ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function write(data: StoreFile): void {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Atomic write: tmp + rename so a crash mid-write doesn't corrupt the file.
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  }

  return {
    path,
    save(name, body, description) {
      const data = read();
      const entry: SavedQueryEntry = {
        name,
        body,
        ...(description ? { description } : {}),
        saved_at: new Date().toISOString(),
      };
      data.queries[name] = entry;
      write(data);
      return entry;
    },
    get(name) {
      return read().queries[name] ?? null;
    },
    list() {
      return Object.values(read().queries).sort((a, b) => a.name.localeCompare(b.name));
    },
    delete(name) {
      const data = read();
      if (!(name in data.queries)) return false;
      delete data.queries[name];
      write(data);
      return true;
    },
  };
}
