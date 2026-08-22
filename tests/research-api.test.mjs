import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/research-engine.js';

async function body(response) {
  return response.json();
}

const health = await onRequestGet({
  request: new Request('https://example.com/api/research-engine?module=health'),
  env: {},
});
assert.equal(health.status, 200);
const healthData = await body(health);
assert.equal(healthData.ok, true);
assert.equal(healthData.configured.alpaca, false);
assert.equal(JSON.stringify(healthData).includes('ALPACA_SECRET_KEY'), false, 'health must not expose secret names or values');

const unauthorized = await onRequestGet({
  request: new Request('https://example.com/api/research-engine?module=options'),
  env: { ALPACA_API_KEY: 'test', ALPACA_SECRET_KEY: 'test' },
});
assert.equal(unauthorized.status, 401);

const originalFetch = globalThis.fetch;
const requested = [];
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  requested.push(url);
  if (url.pathname === '/v2/stocks/QQQ/snapshot') {
    return Response.json({ latestTrade: { p: 600 } });
  }
  if (url.pathname === '/v2/options/contracts') {
    return Response.json({ option_contracts: [
      { symbol: 'QQQ260828C00600000', type: 'call', strike_price: '600', open_interest: '1000' },
      { symbol: 'QQQ260828P00600000', type: 'put', strike_price: '600', open_interest: '800' },
    ] });
  }
  if (url.pathname === '/v1beta1/options/snapshots/QQQ') {
    return Response.json({ snapshots: {
      QQQ260828C00600000: { greeks: { gamma: 0.02 } },
      QQQ260828P00600000: { greeks: { gamma: 0.02 } },
    } });
  }
  return new Response(JSON.stringify({ message: `Unexpected test URL: ${url}` }), { status: 404 });
};

try {
  const options = await onRequestGet({
    request: new Request('https://example.com/api/research-engine?module=options&symbol=QQQ&expiryDays=7', {
      headers: { 'X-Research-Cron': 'cron-test-secret' },
    }),
    env: {
      ALPACA_API_KEY: 'test-key',
      ALPACA_SECRET_KEY: 'test-secret',
      RESEARCH_CRON_SECRET: 'cron-test-secret',
    },
  });
  assert.equal(options.status, 200);
  const optionsData = await body(options);
  assert.equal(optionsData.ok, true);
  assert.equal(optionsData.data.contractsAnalyzed, 2);
  assert.ok(optionsData.data.netGexMm > 0, 'call OI exceeds put OI in the modeled test fixture');
  assert.ok(requested.some((url) => url.searchParams.get('feed') === 'indicative'), 'free options requests must explicitly select the indicative feed');
  assert.ok(requested.every((url) => !url.toString().includes('test-secret')), 'API secrets must stay in headers rather than URLs');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('VJM research API route tests passed.');
