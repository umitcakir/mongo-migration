'use strict';

const path = require('node:path');
const express = require('express');
const { ConnectionRegistry } = require('./connections');
const { MigrationManager } = require('./migrator');

const START_TIME = new Date().toISOString();

function createServer() {
  const app = express();
  const registry = new ConnectionRegistry();
  const migrations = new MigrationManager(registry);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  }));

  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  // The API drives real data movement, so block cross-site and DNS-rebinding access.
  app.use('/api', (req, res, next) => {
    const host = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
      return res.status(403).json({ error: 'Requests must target localhost' });
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
      return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
    }
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({
      version: require('../package.json').version,
      pid: process.pid,
      startedAt: START_TIME,
    });
  });

  app.get('/api/connections', wrap(async (req, res) => {
    res.json(registry.list());
  }));

  app.post('/api/connections', wrap(async (req, res) => {
    const connection = await registry.add({ name: req.body?.name, uri: req.body?.uri });
    res.status(201).json(connection);
  }));

  app.delete('/api/connections/:id', wrap(async (req, res) => {
    await registry.remove(req.params.id);
    res.status(204).end();
  }));

  app.get('/api/connections/:id/databases', wrap(async (req, res) => {
    res.json(await registry.listDatabases(req.params.id, { includeSystem: req.query.includeSystem === 'true' }));
  }));

  app.get('/api/connections/:id/databases/:db/collections', wrap(async (req, res) => {
    res.json(await registry.listCollections(req.params.id, req.params.db));
  }));

  app.post('/api/jobs', wrap(async (req, res) => {
    const job = migrations.createJob(req.body || {});
    res.status(201).json(migrations.toPublic(job));
  }));

  app.get('/api/jobs/:id', wrap(async (req, res) => {
    res.json(migrations.toPublic(migrations.getJob(req.params.id)));
  }));

  app.post('/api/jobs/:id/cancel', wrap(async (req, res) => {
    res.json(migrations.cancel(req.params.id));
  }));

  app.get('/api/jobs/:id/events', wrap(async (req, res) => {
    const job = migrations.getJob(req.params.id);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send(migrations.toPublic(job));

    const listener = (payload) => {
      send(payload);
      if (payload.status !== 'running') res.end();
    };
    migrations.on(`job:${job.id}`, listener);

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      migrations.off(`job:${job.id}`, listener);
    });
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.message || 'Unexpected error' });
  });

  return { app, registry };
}

module.exports = { createServer };
