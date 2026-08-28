'use strict';

const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');

const SYSTEM_DBS = new Set(['admin', 'local', 'config']);

/**
 * In-memory registry of live MongoDB connections.
 * Credentials never leave this process and are never sent back to the UI.
 */
class ConnectionRegistry {
  constructor() {
    /** @type {Map<string, {id: string, name: string, host: string, client: MongoClient}>} */
    this.connections = new Map();
  }

  static describe(uri) {
    // mongodb URIs may list several hosts, which the URL parser cannot handle.
    const match = /^(mongodb(?:\+srv)?):\/\/(?:[^@/]*@)?([^/?]+)/i.exec(uri);
    if (!match) return 'unknown host';
    return `${match[1]}://${match[2]}`;
  }

  async add({ name, uri }) {
    if (typeof uri !== 'string' || !/^mongodb(\+srv)?:\/\//i.test(uri)) {
      throw Object.assign(new Error('A valid mongodb:// or mongodb+srv:// URI is required'), { status: 400 });
    }

    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 8000,
      maxPoolSize: 20,
    });

    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
    } catch (err) {
      await client.close().catch(() => {});
      throw Object.assign(new Error(`Connection failed: ${err.message}`), { status: 400 });
    }

    const id = crypto.randomUUID();
    const entry = {
      id,
      name: (name && String(name).trim()) || ConnectionRegistry.describe(uri),
      host: ConnectionRegistry.describe(uri),
      client,
    };
    this.connections.set(id, entry);
    return this.toPublic(entry);
  }

  toPublic(entry) {
    return { id: entry.id, name: entry.name, host: entry.host };
  }

  list() {
    return [...this.connections.values()].map((entry) => this.toPublic(entry));
  }

  get(id) {
    const entry = this.connections.get(id);
    if (!entry) {
      throw Object.assign(new Error('Unknown connection id'), { status: 404 });
    }
    return entry;
  }

  client(id) {
    return this.get(id).client;
  }

  async remove(id) {
    const entry = this.get(id);
    this.connections.delete(id);
    await entry.client.close().catch(() => {});
  }

  async listDatabases(id, { includeSystem = false } = {}) {
    const admin = this.client(id).db().admin();
    // Users without cluster-wide rights can only list the databases they are authorized for.
    const { databases } = await admin
      .listDatabases()
      .catch(() => admin.listDatabases({ nameOnly: true, authorizedDatabases: true }));

    return databases
      .filter((db) => includeSystem || !SYSTEM_DBS.has(db.name))
      .map((db) => ({ name: db.name, sizeOnDisk: db.sizeOnDisk ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listCollections(id, dbName) {
    const db = this.client(id).db(dbName);
    const infos = await db.listCollections({}, { nameOnly: false }).toArray();
    const collections = infos
      .filter((info) => info.type !== 'view' && !info.name.startsWith('system.'))
      .map((info) => info.name)
      .sort((a, b) => a.localeCompare(b));

    return Promise.all(
      collections.map(async (name) => ({
        name,
        count: await db.collection(name).estimatedDocumentCount().catch(() => null),
      })),
    );
  }

  async closeAll() {
    await Promise.all([...this.connections.values()].map((entry) => entry.client.close().catch(() => {})));
    this.connections.clear();
  }
}

module.exports = { ConnectionRegistry };
