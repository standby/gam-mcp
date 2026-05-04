import { createRestGamClient } from '../src/gam-client-rest.js';
import { createGoogleAuth, createAuthFetch } from '../src/auth.js';
import { resolveDateRange } from '../src/dates.js';

async function main(): Promise<void> {
  const networkCode = process.env.GAM_NETWORK_CODE;
  const keyFile = process.env.GAM_SERVICE_ACCOUNT_KEY_FILE;
  if (!networkCode || !keyFile) {
    process.stderr.write('Set GAM_NETWORK_CODE and GAM_SERVICE_ACCOUNT_KEY_FILE.\n');
    process.exit(2);
  }
  const tz = process.env.GAM_TIMEZONE ?? 'America/Los_Angeles';

  const auth = createGoogleAuth(keyFile);
  const fetchImpl = createAuthFetch(auth);
  const client = createRestGamClient({ networkCode, fetchImpl });

  process.stderr.write('1. Listing 5 most recent orders...\n');
  const orders = await client.listEntities({ entity_type: 'order' });
  process.stderr.write(`   got ${orders.length} orders; first: ${JSON.stringify(orders[0])}\n`);

  process.stderr.write('2. Running tiny report (yesterday, top advertisers, impressions)...\n');
  const range = resolveDateRange({ relative: 'yesterday' }, tz);
  const op = await client.createReport(
    { dimensions: ['ADVERTISER_NAME'], metrics: ['IMPRESSIONS'] },
    range,
  );
  process.stderr.write(`   operation: ${op.operation_name}\n`);

  let attempts = 0;
  while (attempts++ < 60) {
    const s = await client.pollOperation(op.operation_name);
    if (s.state === 'done') {
      process.stderr.write(`   done; download: ${s.download_url}\n`);
      const path = await client.downloadReport(s.download_url, '/tmp/gam-mcp-smoke.csv.gz');
      process.stderr.write(`   wrote: ${path}\n`);
      process.stderr.write('SMOKE OK\n');
      return;
    }
    if (s.state === 'failed') {
      process.stderr.write(`   FAILED: ${s.reason}\n`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  process.stderr.write('   timed out after 60 attempts\n');
  process.exit(1);
}

main().catch((e) => { process.stderr.write(`smoke: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
