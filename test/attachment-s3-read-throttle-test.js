/* global BigInt */
'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Readable } = require('stream');
const { ObjectId } = require('mongodb');

const scriptPath = path.join(__dirname, '../scripts/migrate-attachments-to-s3.js');
const script = fs.readFileSync(scriptPath, 'utf8');
const MiB = 1024 * 1024;

// Run the actual CLI with storage and a monotonic clock under test control.
// No production configuration, network connections or real pacing waits are used.
async function run(options = {}) {
    const payload = Buffer.alloc(options.bytes === undefined ? MiB : options.bytes, 'a');
    const id = Buffer.alloc(32, 1);
    const file = {
        _id: id,
        length: payload.length,
        metadata: {
            fileContentHash: crypto.createHash('sha256').update(payload).digest('base64'),
            storage: { backend: options.gridfsRecord ? 'gridfs' : 's3', migratedAt: new Date(0) }
        }
    };
    const events = [];
    const delays = [];
    let locked = false;
    let sourceReading = false;
    let now = 0n;
    let connected = false;
    let listed = false;
    let stdout = '';
    let stderr = '';
    let exitCode;
    let finish;
    const finished = new Promise(resolve => (finish = resolve));
    const advance = milliseconds => (now += BigInt(Math.ceil(milliseconds * 1e6)));
    const files = {
        async findOne() {
            return file;
        },
        async updateOne() {
            return { matchedCount: 1 };
        },
        find() {
            return {
                sort() {
                    return this;
                },
                limit() {
                    return this;
                },
                async toArray() {
                    if (options.listError) {
                        throw new Error('listing failed');
                    }
                    const page = listed ? [] : [{ _id: id }];
                    listed = true;
                    return page;
                }
            };
        }
    };
    const chunks = {
        async findOne() {
            return options.sourceMissing ? null : { _id: new ObjectId() };
        },
        async deleteMany() {
            events.push('cleanup');
            advance(options.cleanupMilliseconds || 0);
        }
    };
    const storage = {
        s3: {
            async store(key, source, length, checksum, cutover) {
                for await (const chunk of source) {
                    expect(Buffer.isBuffer(chunk)).to.equal(true);
                }
                return await cutover({ bucket: 'test', key: 'test' });
            },
            openRange() {
                return Readable.from(
                    (async function* () {
                        advance(options.s3Milliseconds || 0);
                        if (options.destinationError) {
                            throw new Error('S3 read failed');
                        }
                        yield payload;
                    })()
                );
            }
        },
        gridstore: {
            gridstore: {
                openDownloadStream() {
                    return Readable.from(
                        (async function* () {
                            events.push('source:start');
                            sourceReading = true;
                            try {
                                yield payload.subarray(0, Math.floor(payload.length / 2));
                                advance(options.readMilliseconds || 0);
                                if (options.sourceError) {
                                    throw new Error('GridFS read aborted');
                                }
                                yield options.sourceMismatch ? Buffer.from('different') : payload.subarray(Math.floor(payload.length / 2));
                            } finally {
                                sourceReading = false;
                                events.push('source:end');
                            }
                        })()
                    );
                }
            }
        },
        lock: {
            async run(key, operation) {
                events.push('lock');
                locked = true;
                try {
                    await operation(() => {
                        if (options.lockLost) {
                            throw new Error('Lost attachment lock');
                        }
                    });
                } finally {
                    locked = false;
                    advance(options.releaseMilliseconds || 0);
                    events.push('unlock');
                }
            }
        },
        backend() {}
    };
    const dependencies = {
        crypto,
        mongodb: { ObjectId },
        '@aws-sdk/client-s3': {},
        '@zone-eu/wild-config': { attachments: { s3: { bucket: 'test', prefix: 'test' } } },
        '../lib/db': {
            connect(callback) {
                connected = true;
                callback();
            },
            gridfs: { collection: name => (name.endsWith('.files') ? files : chunks) }
        },
        '../lib/attachment-storage': class {
            constructor() {
                return storage;
            }
        }
    };
    const context = {
        Buffer,
        require(name) {
            if (!Object.hasOwn(dependencies, name)) {
                throw new Error(`Unexpected dependency: ${name}`);
            }
            return dependencies[name];
        },
        setTimeout(callback, milliseconds) {
            expect(locked, 'pacing must not hold the attachment lock').to.equal(false);
            expect(sourceReading, 'pacing must not stall an open GridFS cursor').to.equal(false);
            expect(milliseconds).to.be.at.most(2147483647);
            events.push('wait');
            delays.push(milliseconds);
            advance(milliseconds);
            queueMicrotask(callback);
        },
        process: {
            argv: ['node', scriptPath, ...(options.args || ['--verify-only', '--read-mibps=1'])],
            hrtime: { bigint: () => now },
            stdout: { write: text => (stdout += text) },
            stderr: { write: text => (stderr += text) },
            exit(code) {
                exitCode = code;
                finish();
                if (!connected) {
                    throw new Error('CLI validation exit');
                }
            }
        }
    };
    try {
        vm.runInNewContext(script, context, { filename: scriptPath });
    } catch (err) {
        if (exitCode === undefined) {
            throw err;
        }
    }
    await finished;
    return { exitCode, connected, events, delays, stderr, stats: stdout ? JSON.parse(stdout.trim().split('\n').pop()) : undefined };
}

describe('S3 migration retained GridFS read pacing', () => {
    for (const args of [['--read-mibps'], ['--read-mibps='], ['--read-mibps=1', '--read-mibps=2']]) {
        it(`rejects missing or duplicate rate arguments: ${args.join(' ')}`, async () => {
            const result = await run({ args: ['--verify-only', ...args] });
            expect(result.exitCode).to.equal(2);
            expect(result.connected).to.equal(false);
        });
    }

    for (const value of ['-1', 'NaN', 'Infinity', '-Infinity', '1e309', '1e308', 'invalid']) {
        it(`rejects --read-mibps=${value} before connecting`, async () => {
            const result = await run({ args: ['--verify-only', `--read-mibps=${value}`] });
            expect(result.exitCode).to.equal(2);
            expect(result.connected).to.equal(false);
            expect(result.stderr).to.include('--read-mibps=N');
        });
    }

    for (const args of [[], ['--read-mibps=0'], ['--read-mibps', '0']]) {
        it(`disables pacing with ${args.join(' ') || 'the default rate'}`, async () => {
            const result = await run({ args: ['--verify-only', ...args] });
            expect(result.exitCode).to.equal(0);
            expect(result.stats.verified).to.equal(1);
            expect(result.delays).to.deep.equal([]);
        });
    }

    for (const value of ['0.5', '5e-1']) {
        it(`accepts a finite fractional rate ${value} in either argument form`, async () => {
            for (const args of [[`--read-mibps=${value}`], ['--read-mibps', value]]) {
                const result = await run({ args: ['--verify-only', ...args], bytes: MiB / 4, readMilliseconds: 125 });
                expect(result.exitCode).to.equal(0);
                expect(result.delays).to.deep.equal([375]);
            }
        });
    }

    it('measures source bytes and read duration, excludes earlier S3 time and releases the lock before waiting', async () => {
        const result = await run({ bytes: MiB / 2, readMilliseconds: 100, s3Milliseconds: 900, releaseMilliseconds: 25 });
        expect(result.exitCode).to.equal(0);
        expect(result.stats).to.include({ verified: 1, failed: 0 });
        expect(result.delays).to.deep.equal([375]);
        expect(result.events).to.deep.equal(['lock', 'source:start', 'source:end', 'unlock', 'wait']);
    });

    it('handles a source read starting at monotonic time zero', async () => {
        const result = await run();
        expect(result.exitCode).to.equal(0);
        expect(result.delays).to.deep.equal([1000]);
    });

    it('counts cleanup time toward pacing and waits after deleting chunks and unlocking', async () => {
        const result = await run({ args: ['--cleanup-chunks', '--yes', '--read-mibps=1'], readMilliseconds: 100, cleanupMilliseconds: 300 });
        expect(result.exitCode).to.equal(0);
        expect(result.stats).to.include({ verified: 1, cleaned: 1 });
        expect(result.delays).to.deep.equal([600]);
        expect(result.events).to.deep.equal(['lock', 'source:start', 'source:end', 'cleanup', 'unlock', 'wait']);
    });

    it('does not add a delay when source reading is already slow enough', async () => {
        const result = await run({ readMilliseconds: 1500 });
        expect(result.exitCode).to.equal(0);
        expect(result.delays).to.deep.equal([]);
    });

    it('leaves migration hash and upload reads unpaced', async () => {
        const result = await run({ args: ['--migrate', '--read-mibps=1'], gridfsRecord: true });
        expect(result.exitCode).to.equal(0);
        expect(result.stats).to.include({ migrated: 1, failed: 0 });
        expect(result.events.filter(event => event === 'source:start')).to.have.length(2);
        expect(result.delays).to.deep.equal([]);
    });

    for (const options of [{ sourceMissing: true }, { bytes: 0 }, { args: ['--dry-run', '--read-mibps=1'] }]) {
        it(`does not wait without source bytes: ${JSON.stringify(options)}`, async () => {
            const result = await run(options);
            expect(result.exitCode).to.equal(0);
            expect(result.delays).to.deep.equal([]);
        });
    }

    it('splits long waits at the Node timer limit', async () => {
        const result = await run({ args: ['--verify-only', '--read-mibps=0.00000025'] });
        expect(result.exitCode).to.equal(0);
        expect(result.delays).to.deep.equal([2147483647, 1852516353]);
    });

    for (const [options, message] of [
        [{ sourceError: true }, 'GridFS read aborted'],
        [{ destinationError: true }, 'S3 read failed'],
        [{ sourceMismatch: true }, 'GridFS and S3 differ'],
        [{ args: ['--cleanup-chunks', '--yes', '--read-mibps=1'], lockLost: true }, 'Lost attachment lock']
    ]) {
        it(`reports ${message}, releases the lock and exits without pacing the failed entry`, async () => {
            const result = await run(options);
            expect(result.exitCode).to.equal(1);
            expect(result.stats.failed).to.equal(1);
            expect(result.stderr).to.include(message);
            expect(result.events).to.include('unlock');
            expect(result.delays).to.deep.equal([]);
        });
    }

    it('reports a listing failure without starting reads or waits', async () => {
        const result = await run({ listError: true });
        expect(result.exitCode).to.equal(1);
        expect(result.stderr).to.include('listing failed');
        expect(result.events).to.deep.equal([]);
        expect(result.delays).to.deep.equal([]);
    });
});
