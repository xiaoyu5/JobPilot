import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { testConnection, validateEndpoint } from '@jobpilot/llm';
import { redact } from '@jobpilot/contracts';

test('endpoint validation rejects credentials, public destinations and unapproved LAN', () => {
  for (const baseUrl of ['file:///tmp/a', 'https://example.com/v1', 'http://user:pass@localhost/v1', 'http://192.168.1.2/v1', 'http://localhost/v1?key=secret']) {
    assert.throws(() => validateEndpoint({baseUrl, model: 'test'}));
  }
  assert.equal(validateEndpoint({baseUrl: 'http://127.0.0.1:1/v1/', model: 'test'}).baseUrl, 'http://127.0.0.1:1/v1');
  assert.doesNotThrow(() => validateEndpoint({baseUrl: 'http://192.168.1.2/v1', model: 'test', allowLan: true}));
});

async function mockServer(handler: (body: any, url: string) => {status: number; value: unknown}, run: (baseUrl: string) => Promise<void>) {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const result = handler(body ? JSON.parse(body) : undefined, req.url!);
    res.writeHead(result.status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(result.value));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as {port: number}).port}/v1`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const reply = (content: string) => ({status: 200, value: {choices: [{message: {content}}]}});

test('models failure does not block chat; rejected response_format falls back and validates JSON', async () => {
  let calls = 0;
  await mockServer((body, url) => {
    calls++;
    if (url.endsWith('/models')) return {status: 404, value: {error: 'unsupported'}};
    if (body.response_format) return {status: 400, value: {error: 'format unsupported'}};
    return reply(body.messages[0].content.includes('JSON') ? '{"ok":true}' : 'OK');
  }, async baseUrl => {
    const result = await testConnection({baseUrl, model: 'fixture'});
    assert.equal(result.healthy, true); assert.equal(result.models.ok, false);
    assert.equal(result.json.responseFormatSupported, false); assert.equal(calls, 4);
  });
});

test('invalid model JSON fails closed; credentials and contacts are redacted', async () => {
  await mockServer((body, url) => url.endsWith('/models') ? {status: 401, value: {error: 'test-api-key 13800138000 person@example.com'}} : reply(body.messages[0].content.includes('JSON') ? '{"ok":false}' : 'OK'), async baseUrl => {
    const result = await testConnection({baseUrl, model: 'fixture', apiKey: 'test-api-key'});
    assert.equal(result.healthy, false); assert.equal(result.json.ok, false);
    const text = JSON.stringify(result);
    for (const secret of ['test-api-key', '13800138000', 'person@example.com']) assert.equal(text.includes(secret), false);
  });
  assert.equal(redact('Bearer abc 13800138000 x@y.com'), 'Bearer [REDACTED] [PHONE] [EMAIL]');
});

test('service unavailable produces a usable diagnostic without inventing success', async () => {
  const result = await testConnection({baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', timeoutMs: 100});
  assert.equal(result.healthy, false); assert.equal(result.chat.ok, false);
});
