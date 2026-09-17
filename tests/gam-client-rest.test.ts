import { describe, it, expect, vi } from 'vitest';
import { createRestGamClient, withRetries } from '../src/gam-client-rest.js';
import { createFakeGam } from './fake-gam.js';
import { definitionFor } from './helpers.js';
import { definitionHash, reportName } from '../src/report-key.js';

describe('REST GAM client', () => {
  it('listEntities GETs the right path and maps fields', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      expect(u).toContain('/networks/12345/orders');
      return new Response(JSON.stringify({
        orders: [
          { orderId: '111', name: 'Order A' },
          { orderId: '222', name: 'Order B' },
        ],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    const r = await client.listEntities({ entity_type: 'order' });
    expect(r).toEqual([
      { id: 111, name: 'Order A' },
      { id: 222, name: 'Order B' },
    ]);
  });

  it('defineReport POSTs exactly the definition it is given; runReport POSTs :run', async () => {
    const gam = createFakeGam();
    const client = createRestGamClient({ networkCode: '1234', fetchImpl: gam.fetch });
    const definition = definitionFor(
      { dimensions: ['ADVERTISER_NAME'], metrics: ['IMPRESSIONS'] },
      { start: '2026-04-01', end: '2026-04-29' },
    );
    const { report } = await client.defineReport(definition);
    expect(report).toBe('networks/1234/reports/1');
    expect(gam.requests.at(-1)).toEqual({
      method: 'POST',
      path: 'networks/1234/reports',
      body: { displayName: reportName(definitionHash(definition)), reportDefinition: definition },
    });
    const { operation } = await client.runReport(report);
    expect(operation).toBe('networks/1234/operations/reports/runs/1');
    expect(gam.requests.at(-1)).toEqual({ method: 'POST', path: `${report}:run`, body: {} });
  });

  it('listEntities query emits AIP-160 has-operator on displayName (no CONTAINS keyword)', async () => {
    // Regression: previous wire shape was `name:CONTAINS:"foo"` which GAM
    // rejects as a parse error — the Reports API has a CONTAINS enum, but
    // list filters do not, and `name` is the resource path, not the
    // user-visible label. The fix uses `displayName:"foo"` (has-operator).
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ orders: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    await client.listEntities({ entity_type: 'order', query: 'back_to_school_2026' });
    // Decode the filter param off the URL and assert exact shape.
    const params = new URL(capturedUrl).searchParams;
    expect(params.get('filter')).toBe('displayName:"back_to_school_2026"');
    expect(params.get('filter')).not.toMatch(/CONTAINS/);
  });

  it('listEntities pages through GAM transparently up to limit', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls++;
      const u = String(url);
      // Page 1: 200 items + nextPageToken
      if (calls === 1) {
        expect(u).not.toContain('pageToken=');
        return new Response(JSON.stringify({
          orders: Array.from({ length: 200 }, (_, i) => ({ orderId: String(i + 1), displayName: `O${i + 1}` })),
          nextPageToken: 'tok-2',
        }), { status: 200 });
      }
      // Page 2: 50 items, no nextPageToken
      expect(u).toContain('pageToken=tok-2');
      return new Response(JSON.stringify({
        orders: Array.from({ length: 50 }, (_, i) => ({ orderId: String(201 + i), displayName: `O${201 + i}` })),
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    const r = await client.listEntities({ entity_type: 'order', limit: 250 });
    expect(r.length).toBe(250);
    expect(r[0].id).toBe(1);
    expect(r[249].id).toBe(250);
    expect(calls).toBe(2);
  });

  it('withRetries retries on 429 then succeeds, surfaces non-retryable 4xx immediately', async () => {
    let calls = 0;
    const flakyFetch = (async () => {
      calls++;
      if (calls === 1) return new Response('quota', { status: 429 });
      if (calls === 2) return new Response('ok', { status: 200 });
      throw new Error('unexpected call');
    }) as unknown as typeof fetch;
    const wrapped = withRetries(flakyFetch, { baseDelayMs: 1, maxAttempts: 3 });
    const res = await wrapped('https://example.test');
    expect(res.status).toBe(200);
    expect(calls).toBe(2);

    let calls404 = 0;
    const notFoundFetch = (async () => {
      calls404++;
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const wrapped404 = withRetries(notFoundFetch, { baseDelayMs: 1, maxAttempts: 3 });
    const res404 = await wrapped404('https://example.test');
    expect(res404.status).toBe(404);
    expect(calls404).toBe(1); // 4xx (not 429) is not retried
  });

  it('listEntities supports custom_targeting_key path, exposing both adTagName (as name) and displayName', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('/networks/12345/customTargetingKeys');
      return new Response(JSON.stringify({
        customTargetingKeys: [
          { customTargetingKeyId: '111', adTagName: 'channel_id', displayName: 'Channel ID', name: 'networks/12345/customTargetingKeys/111' },
          { customTargetingKeyId: '222', adTagName: 'tier',       displayName: 'Tier',       name: 'networks/12345/customTargetingKeys/222' },
          // older fixtures without adTagName still resolve cleanly (fallback to displayName).
          { customTargetingKeyId: '333', displayName: 'section',  name: 'networks/12345/customTargetingKeys/333' },
        ],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    const r = await client.listEntities({ entity_type: 'custom_targeting_key' });
    expect(r).toEqual([
      { id: 111, name: 'channel_id', displayName: 'Channel ID' },
      { id: 222, name: 'tier',       displayName: 'Tier' },
      // adTagName missing → name = displayName, displayName field omitted (would be redundant).
      { id: 333, name: 'section' },
    ]);
  });

  it('listEntities match="exact" on custom_targeting_key uses `name = "..."` filter (GAM rejects substring on this attribute)', async () => {
    let capturedFilter: string | null = null;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      capturedFilter = new URL(String(url)).searchParams.get('filter');
      return new Response(JSON.stringify({ customTargetingKeys: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    await client.listEntities({
      entity_type: 'custom_targeting_key',
      query: 'channel_id',
      match: 'exact',
    });
    expect(capturedFilter).toBe('name = "channel_id"');
  });

  it('listEntities by ids uses per-id direct GETs, never a list filter', async () => {
    // Regression: previous wire shape filtered with
    // `customTargetingKeyId=<n>` which GAM rejects ("Field is not supported
    // for filtering"). Fix routes by-id lookups for this resource through
    // GET /networks/{n}/customTargetingKeys/{id}.
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      seen.push(u);
      // No URL we hit should construct a list filter for this resource.
      expect(u).not.toContain('filter=');
      if (u.endsWith('/customTargetingKeys/11002726')) {
        return new Response(JSON.stringify({
          customTargetingKeyId: '11002726',
          adTagName: 'main_category_id',
          displayName: 'Main Category ID',
          name: 'networks/12345/customTargetingKeys/11002726',
        }), { status: 200 });
      }
      if (u.endsWith('/customTargetingKeys/11002727')) {
        return new Response(JSON.stringify({
          customTargetingKeyId: '11002727',
          adTagName: 'section',
          displayName: 'Section',
          name: 'networks/12345/customTargetingKeys/11002727',
        }), { status: 200 });
      }
      // 404s drop silently (resource deleted between list and get).
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    const r = await client.listEntities({
      entity_type: 'custom_targeting_key',
      ids: [11002726, 11002727, 99999],
    });
    expect(r).toEqual([
      { id: 11002726, name: 'main_category_id', displayName: 'Main Category ID' },
      { id: 11002727, name: 'section', displayName: 'Section' },
    ]);
    expect(seen).toHaveLength(3);
  });

  // GAM answers `?filter=lineItemId=<n>` with
  // `400 Field lineItemId is not supported for filtering.` — same for adUnits,
  // placements and customTargetingKeys. Only companies/orders accept it, which
  // is not worth a second code path, so every type takes the direct-GET route.
  it.each([
    ['line_item', 'lineItems', 'lineItemId'],
    ['ad_unit', 'adUnits', 'adUnitId'],
    ['placement', 'placements', 'placementId'],
    ['order', 'orders', 'orderId'],
  ] as const)('listEntities by ids for %s GETs each id directly', async (entity_type, collection, idField) => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      seen.push(u);
      // A list filter here would 400 against the live API.
      expect(u).not.toContain('filter=');
      const id = u.split('/').pop();
      return new Response(JSON.stringify({
        [idField]: id,
        displayName: `Entity ${id}`,
        name: `networks/12345/${collection}/${id}`,
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    const r = await client.listEntities({ entity_type, ids: [111, 222] });
    expect(seen).toEqual([
      `https://admanager.googleapis.com/v1/networks/12345/${collection}/111`,
      `https://admanager.googleapis.com/v1/networks/12345/${collection}/222`,
    ]);
    expect(r).toEqual([
      { id: 111, name: 'Entity 111' },
      { id: 222, name: 'Entity 222' },
    ]);
  });

  it('getResource returns the raw resource and null on 404', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      seen.push(u);
      if (u.endsWith('/lineItems/1')) {
        return new Response(JSON.stringify({ name: 'networks/12345/lineItems/1', status: 'DELIVERING' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    expect(await client.getResource('lineItems/1')).toEqual({
      name: 'networks/12345/lineItems/1',
      status: 'DELIVERING',
    });
    // Absolute resource names (the shape GAM embeds inside targeting) are not
    // re-prefixed with the network path.
    expect(await client.getResource('networks/12345/customTargetingValues/9')).toBeNull();
    expect(seen).toEqual([
      'https://admanager.googleapis.com/v1/networks/12345/lineItems/1',
      'https://admanager.googleapis.com/v1/networks/12345/customTargetingValues/9',
    ]);
  });

  it('listEntities substring query on custom_targeting_key auto-retries with `name = "..."` after a 400 parse error', async () => {
    // GAM may reject `displayName:"<key>"` substring on this resource. The
    // REST client falls back to exact-equality on `name` so the call
    // succeeds without the caller knowing.
    let calls = 0;
    const seenFilters: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls++;
      const u = String(url);
      const f = new URL(u).searchParams.get('filter') ?? '';
      seenFilters.push(f);
      if (calls === 1) {
        // First attempt: substring. GAM rejects.
        expect(f).toBe('displayName:"main_category_id"');
        return new Response('{"error":{"code":400,"message":"Filter failed to parse"}}', { status: 400 });
      }
      // Second attempt: exact equality on `name`. GAM accepts.
      expect(f).toBe('name = "main_category_id"');
      return new Response(JSON.stringify({
        customTargetingKeys: [{
          customTargetingKeyId: '11002726',
          adTagName: 'main_category_id',
          displayName: 'Main Category ID',
          name: 'networks/12345/customTargetingKeys/11002726',
        }],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    const r = await client.listEntities({
      entity_type: 'custom_targeting_key',
      query: 'main_category_id',
    });
    expect(calls).toBe(2);
    expect(r).toEqual([
      { id: 11002726, name: 'main_category_id', displayName: 'Main Category ID' },
    ]);
  });

  it('listEntities match="exact" on entities other than custom_targeting_key falls back to `displayName = "..."`', async () => {
    let capturedFilter: string | null = null;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      capturedFilter = new URL(String(url)).searchParams.get('filter');
      return new Response(JSON.stringify({ orders: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    await client.listEntities({ entity_type: 'order', query: 'Q1 Brand', match: 'exact' });
    expect(capturedFilter).toBe('displayName = "Q1 Brand"');
  });
});
