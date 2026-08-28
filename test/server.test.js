const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createServer } = require('../src/server');

function request(server, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, port: server.address().port }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('reports health and blocks non-local API hosts', async (t) => {
  const { app, registry } = createServer();
  const server = http.createServer(app);
  t.after(async () => {
    await registry.closeAll();
    server.close();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const health = await request(server, { path: '/api/health', headers: { host: '127.0.0.1' } });
  assert.equal(health.statusCode, 200);
  assert.equal(JSON.parse(health.body).version, require('../package.json').version);

  const blocked = await request(server, { path: '/api/health', headers: { host: 'attacker.example' } });
  assert.equal(blocked.statusCode, 403);
});