'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const DEFAULT_BATCH_SIZE = 1000;
const PROGRESS_EMIT_INTERVAL_MS = 400;
const HEARTBEAT_INTERVAL_MS = 1000;
const EXACT_COUNT_THRESHOLD = 100000;
const LOG_EVERY_DOCS = 100000;

function describeClient(client) {
  const hosts = client.options?.hosts;
  if (!hosts?.length) return 'unknown host';
  return hosts.map((host) => String(host)).join(',');
}

/**
 * Runs collection copy jobs and streams progress events.
 * Every job is a list of tasks: one source collection -> one target collection.
 */
class MigrationManager extends EventEmitter {
  constructor(registry) {
    super();
    this.setMaxListeners(0);
    this.registry = registry;
    /** @type {Map<string, any>} */
    this.jobs = new Map();
  }

  createJob(spec) {
    const tasks = (spec.tasks || []).map((task, index) => ({
      index,
      sourceDatabase: task.sourceDatabase,
      sourceCollection: task.sourceCollection,
      targetDatabase: task.targetDatabase || task.sourceDatabase,
      targetCollection: task.targetCollection || task.sourceCollection,
      status: 'pending',
      phase: null,
      total: 0,
      read: 0,
      copied: 0,
      failed: 0,
      error: null,
      startedAt: null,
      finishedAt: null,
      countExact: false,
      indexesCopied: 0,
      targetCount: null,
    }));

    if (!tasks.length) {
      throw Object.assign(new Error('At least one collection mapping is required'), { status: 400 });
    }
    for (const task of tasks) {
      if (!task.sourceDatabase || !task.sourceCollection || !task.targetDatabase || !task.targetCollection) {
        throw Object.assign(new Error('Each mapping needs source/target database and collection'), { status: 400 });
      }
    }

    // Validate connections exist before we start.
    this.registry.get(spec.sourceConnectionId);
    this.registry.get(spec.targetConnectionId);

    const job = {
      id: crypto.randomUUID(),
      sourceConnectionId: spec.sourceConnectionId,
      targetConnectionId: spec.targetConnectionId,
      options: {
        mode: ['insert', 'upsert', 'drop'].includes(spec.mode) ? spec.mode : 'insert',
        batchSize: Number.isInteger(spec.batchSize) && spec.batchSize > 0 ? Math.min(spec.batchSize, 10000) : DEFAULT_BATCH_SIZE,
        copyIndexes: spec.copyIndexes !== false,
        continueOnError: spec.continueOnError !== false,
      },
      tasks,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      log: [],
      cancelled: false,
    };

    this.jobs.set(job.id, job);
    this.#run(job).catch((err) => {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      this.#log(job, 'error', err.message);
      this.#emit(job);
    });
    return job;
  }

  getJob(id) {
    const job = this.jobs.get(id);
    if (!job) {
      throw Object.assign(new Error('Unknown job id'), { status: 404 });
    }
    return job;
  }

  cancel(id) {
    const job = this.getJob(id);
    if (job.status === 'running') {
      job.cancelled = true;
      this.#log(job, 'warn', 'Cancellation requested');
      this.#emit(job);
    }
    return this.toPublic(job);
  }

  toPublic(job) {
    const totals = job.tasks.reduce(
      (acc, task) => {
        acc.total += task.total;
        acc.read += task.read;
        acc.copied += task.copied;
        acc.failed += task.failed;
        if (task.status === 'done') acc.done += 1;
        return acc;
      },
      { total: 0, read: 0, copied: 0, failed: 0, done: 0 },
    );

    return {
      id: job.id,
      status: job.status,
      options: job.options,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      serverTime: new Date().toISOString(),
      totals: { ...totals, tasks: job.tasks.length },
      tasks: job.tasks,
      log: job.log.slice(-200),
    };
  }

  #log(job, level, message) {
    job.log.push({ at: new Date().toISOString(), level, message });
    if (job.log.length > 1000) job.log.splice(0, job.log.length - 1000);
  }

  #emit(job) {
    job.lastEmitAt = Date.now();
    this.emit(`job:${job.id}`, this.toPublic(job));
  }

  // Large collections flush thousands of batches; only push progress a few times per second.
  #emitProgress(job) {
    if (Date.now() - (job.lastEmitAt || 0) >= PROGRESS_EMIT_INTERVAL_MS) this.#emit(job);
  }

  async #run(job) {
    const source = this.registry.client(job.sourceConnectionId);
    const target = this.registry.client(job.targetConnectionId);

    this.#log(job, 'info', `Source server: ${describeClient(source)}`);
    this.#log(job, 'info', `Target server: ${describeClient(target)}`);
    if (describeClient(source) === describeClient(target)) {
      this.#log(job, 'warn', 'Source and target point at the same server.');
    }

    // w=0 makes the server acknowledge nothing, so write failures would pass unnoticed.
    if (Number(target.options?.writeConcern?.w) === 0) {
      this.#log(job, 'warn', 'Target connection uses w=0 (unacknowledged writes): write failures cannot be detected.');
    }

    // Keeps the UI ticking even when a phase produces no progress, so a stall is visible.
    const heartbeat = setInterval(() => this.#emit(job), HEARTBEAT_INTERVAL_MS);

    try {
      await this.#preflight(job, target);
      await this.#runTasks(job, source, target);
    } finally {
      clearInterval(heartbeat);
    }
  }

  // Proves the target really stores what we send before copying millions of documents.
  async #preflight(job, target) {
    const db = target.db(job.tasks[0].targetDatabase);
    const probe = db.collection('__mongo_migration_probe');
    const id = crypto.randomUUID();

    try {
      await probe.insertOne({ _id: id, at: new Date() });
      const found = await probe.countDocuments({ _id: id });
      await probe.deleteOne({ _id: id }).catch(() => {});
      if (!found) {
        throw new Error('the server accepted a test write but did not store it (unacknowledged writes or a proxy in between)');
      }
      this.#log(job, 'info', `Target write test succeeded on ${db.databaseName}`);
    } catch (err) {
      throw new Error(`Target write test failed on ${db.databaseName}: ${err.message}`);
    }
  }

  async #runTasks(job, source, target) {
    for (const task of job.tasks) {
      if (job.cancelled) {
        task.status = 'cancelled';
        continue;
      }

      task.status = 'running';
      task.startedAt = new Date().toISOString();
      this.#log(job, 'info', `Starting ${task.sourceDatabase}.${task.sourceCollection} -> ${task.targetDatabase}.${task.targetCollection}`);
      this.#emit(job);

      try {
        await this.#runTask(job, source, target, task);
        task.status = job.cancelled ? 'cancelled' : 'done';
        this.#log(job, 'info', `Finished ${task.targetDatabase}.${task.targetCollection}: ${task.copied}/${task.total} documents`);
      } catch (err) {
        task.status = 'failed';
        task.error = err.message;
        this.#log(job, 'error', `${task.sourceDatabase}.${task.sourceCollection}: ${err.message}`);
        if (!job.options.continueOnError) {
          task.finishedAt = new Date().toISOString();
          for (const pending of job.tasks) {
            if (pending.status === 'pending') pending.status = 'skipped';
          }
          job.status = 'failed';
          job.finishedAt = new Date().toISOString();
          this.#emit(job);
          return;
        }
      }
      task.finishedAt = new Date().toISOString();
      this.#emit(job);
    }

    const failed = job.tasks.some((t) => t.status === 'failed');
    job.status = job.cancelled ? 'cancelled' : failed ? 'completed_with_errors' : 'completed';
    job.finishedAt = new Date().toISOString();
    this.#log(job, 'info', `Job ${job.status}`);
    this.#emit(job);
  }

  async #runTask(job, sourceClient, targetClient, task) {
    const { batchSize, mode, copyIndexes } = job.options;
    const sourceCollection = sourceClient.db(task.sourceDatabase).collection(task.sourceCollection);
    const targetDb = targetClient.db(task.targetDatabase);
    const targetCollection = targetDb.collection(task.targetCollection);

    task.phase = 'counting';
    this.#emit(job);
    task.total = await sourceCollection.estimatedDocumentCount();
    task.countExact = false;
    // Metadata counts can be stale/wrong on small collections, so verify cheaply.
    if (task.total < EXACT_COUNT_THRESHOLD) {
      task.total = await sourceCollection.countDocuments({});
      task.countExact = true;
    }
    this.#log(job, 'info', `${task.sourceCollection}: ${task.countExact ? '' : '~'}${task.total} document(s) to copy`);
    this.#emit(job);

    if (mode === 'drop') {
      task.phase = 'dropping target';
      this.#emit(job);
      await targetDb.dropCollection(task.targetCollection).catch((err) => {
        if (err.codeName !== 'NamespaceNotFound') throw err;
      });
      this.#log(job, 'warn', `Dropped target collection ${task.targetDatabase}.${task.targetCollection}`);
    }

    task.phase = 'copying';
    this.#emit(job);

    const cursor = sourceCollection.find({}, { batchSize, noCursorTimeout: false });
    let buffer = [];
    let nextMilestone = LOG_EVERY_DOCS;

    try {
      for await (const doc of cursor) {
        if (job.cancelled) break;
        buffer.push(doc);
        task.read += 1;

        if (buffer.length >= batchSize) {
          await this.#flush(job, targetCollection, buffer, task);
          buffer = [];
        }
        if (task.copied >= nextMilestone) {
          this.#log(job, 'info', `${task.sourceCollection}: ${task.copied.toLocaleString()} document(s) copied`);
          nextMilestone += LOG_EVERY_DOCS;
        }
        this.#emitProgress(job);
      }
      if (buffer.length && !job.cancelled) {
        await this.#flush(job, targetCollection, buffer, task);
      }
    } finally {
      await cursor.close().catch(() => {});
    }

    if (copyIndexes && !job.cancelled) {
      task.phase = 'copying indexes';
      this.#emit(job);
      await this.#copyIndexes(job, sourceCollection, targetCollection, task);
    }

    task.phase = 'verifying';
    this.#emit(job);
    task.targetCount = await targetCollection.countDocuments({}).catch(() => null);
    if (task.targetCount !== null) {
      this.#log(job, 'info', `${task.targetDatabase}.${task.targetCollection} now holds ${task.targetCount.toLocaleString()} document(s)`);
    }
    task.phase = null;
  }

  async #flush(job, targetCollection, docs, task) {
    const upsert = job.options.mode === 'upsert';
    const operations = docs.map((doc) =>
      upsert
        ? { replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } }
        : { insertOne: { document: doc } },
    );

    try {
      // Counts are derived from the batch, not the driver result, which reports 0 for unacknowledged writes.
      await targetCollection.bulkWrite(operations, { ordered: false });
      task.copied += operations.length;
    } catch (err) {
      const writeErrors = err.writeErrors || err.result?.result?.writeErrors || [];
      const errorList = Array.isArray(writeErrors) ? writeErrors : [writeErrors];
      const duplicates = errorList.filter((e) => (e.err?.code ?? e.code) === 11000).length;

      if (!errorList.length) throw err;

      task.copied += Math.max(0, operations.length - errorList.length);
      task.failed += errorList.length;

      if (duplicates === errorList.length) {
        this.#log(job, 'warn', `${duplicates} duplicate _id document(s) skipped in ${task.targetCollection}`);
      } else {
        this.#log(job, 'warn', `${errorList.length} write error(s) in ${task.targetCollection}: ${errorList[0].errmsg || errorList[0].err?.errmsg || err.message}`);
      }
    }
  }

  async #copyIndexes(job, sourceCollection, targetCollection, task) {
    const indexes = await sourceCollection.indexes().catch(() => []);
    const specs = indexes
      .filter((index) => index.name !== '_id_')
      .map(({ v, ns, background, ...spec }) => spec);

    if (!specs.length) return;

    try {
      await targetCollection.createIndexes(specs);
      task.indexesCopied = specs.length;
      this.#log(job, 'info', `Copied ${specs.length} index(es) to ${targetCollection.collectionName}`);
    } catch (err) {
      this.#log(job, 'warn', `Index copy failed for ${targetCollection.collectionName}: ${err.message}`);
    }
  }
}

module.exports = { MigrationManager };
