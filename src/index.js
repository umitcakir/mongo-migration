#!/usr/bin/env node
'use strict';

const { createServer } = require('./server');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 4321;

const { app, registry } = createServer();

const server = app.listen(PORT, HOST, async () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  MongoDB Migration Studio running at ${url}\n  Press Ctrl+C to stop.\n`);

  if (process.env.NO_OPEN !== '1') {
    try {
      const open = (await import('open')).default;
      await open(url);
    } catch {
      // Browser auto-open is best effort only.
    }
  }
});

const shutdown = async () => {
  console.log('\nShutting down...');
  await registry.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
