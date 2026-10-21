/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const registerMessages = require('../lib/api/messages');
const { prepareSearchFilter } = require('../lib/prepare-search-filter');
const { compileRouteValidator } = require('../lib/fastify/validation');
const { resolveSystemFlagChanges, resolveUploadFlags } = require('../lib/system-flags');
require('../lib/schemas/json-schemas'); // registers the shared wd:* schemas

// validates one request part on its own, the way the merged route validator sees it
const validatePart = (part, schema, input) => compileRouteValidator({ [part]: schema })(input);

describe('Message custom IMAP flags over the API', () => {
    const routes = [];
    // captures native fastify route registrations: server.route({method, url, config, handler})
    const server = {
        route(options) {
            routes.push({ method: options.method.toLowerCase(), path: options.url, validationObjs: options.config.validationObjs, handler: options.handler });
        },
        lock: {
            async waitAcquireLock() {
                return { success: true, id: 'lock' };
            },
            async extendLock() {
                return { success: true, id: 'lock' };
            },
            async releaseLock() {}
        },
        get() {},
        post() {},
        put() {},
        delete() {}
    };
    const user = new ObjectId();
    const mailbox = new ObjectId();
    const database = {
        collection(name) {
            return {
                async findOne() {
                    return name === 'mailboxes' ? { _id: mailbox, user, path: 'INBOX' } : null;
                }
            };
        }
    };
    const users = {
        collection() {
            return {
                async findOne() {
                    return { _id: user, name: 'Test', address: 'test@example.com' };
                }
            };
        }
    };
    // records what the handlers pass on
    const handled = { updates: [], moves: [], adds: [] };
    const messageHandler = {
        async updateAsync(userId, mailboxId, query, changes) {
            handled.updates.push(changes);
            return 1;
        },
        async moveAsync(options) {
            handled.moves.push(options.updates);
            return { info: { sourceUid: [1], destinationUid: [2] } };
        },
        async addAsync(options) {
            handled.adds.push(options);
            return { status: 'new', data: { uid: 1, mailbox, size: 10 } };
        }
    };
    registerMessages({ database, users, senderDb: database }, server, messageHandler, {}, {}, {});
    const findRoute = (method, path) => routes.find(route => route.method === method && route.path === path);

    // runs a route handler on input that went through the route's own validation, like the server does
    async function call(method, path, input) {
        const route = findRoute(method, path);
        const validated = compileRouteValidator(route.validationObjs)({ ...input });
        if (validated.error) {
            return { status: 400, validationError: validated.error };
        }
        const reply = {
            statusCode: 200,
            body: undefined,
            code(statusCode) {
                this.statusCode = statusCode;
                return this;
            },
            send(body) {
                this.body = body;
                return this;
            }
        };
        const req = { params: validated.value, rawParams: input, role: 'root', validate() {} };
        await route.handler(req, reply);
        return { status: reply.statusCode, body: reply.body };
    }

    const messagePath = '/users/:user/mailboxes/:mailbox/messages/:message';
    const messagesPath = '/users/:user/mailboxes/:mailbox/messages';
    const ids = { user: user.toString(), mailbox: mailbox.toString() };

    beforeEach(() => {
        handled.updates.length = 0;
        handled.moves.length = 0;
        handled.adds.length = 0;
    });

    describe('keyword search', () => {
        for (const method of ['get', 'post']) {
            const part = method === 'get' ? 'queryParams' : 'requestBody';
            const schema = findRoute(method, '/users/:user/search').validationObjs[part];
            const extra = method === 'post' ? { action: { seen: true } } : {};

            it(`${method.toUpperCase()} /users/:user/search matches the keyword against message flags`, async () => {
                const validated = validatePart(part, schema, { keyword: ' MyFlag ', ...extra });
                expect(validated.error).not.to.exist;
                expect(validated.value.keyword).to.equal('MyFlag');

                const user = new ObjectId();
                const db = {
                    users: {
                        collection() {
                            return {
                                async findOne() {
                                    return { _id: user };
                                }
                            };
                        }
                    },
                    database: {
                        collection(name) {
                            throw new Error('Unexpected collection lookup: ' + name);
                        }
                    }
                };
                const { filter } = await prepareSearchFilter(db, user, validated.value);
                expect(filter).to.deep.equal({ user, flags: 'MyFlag' });
            });

            it(`${method.toUpperCase()} /users/:user/search treats an empty keyword as absent`, () => {
                const validated = validatePart(part, schema, { keyword: '', ...extra });
                expect(validated.error).not.to.exist;
                expect(validated.value.keyword).to.equal(undefined);
            });
        }
    });

    const flagFields = [
        ['post', '/users/:user/mailboxes/:mailbox/messages', 'flags'],
        ['put', '/users/:user/mailboxes/:mailbox/messages/:message', 'addFlags'],
        ['put', '/users/:user/mailboxes/:mailbox/messages/:message', 'removeFlags'],
        ['put', '/users/:user/mailboxes/:mailbox/messages', 'addFlags'],
        ['put', '/users/:user/mailboxes/:mailbox/messages', 'removeFlags']
    ];

    // keywords STORE and APPEND refuse, which a mailbox may still hold from before that validation
    const legacyKeywords = ['two words', 'a]b', 'a*b', 'a%b', 'a(b', 'a{b', 'a"b', 'a'.repeat(256), 'café'];
    const label = value => JSON.stringify(value.length > 20 ? value.slice(0, 20) + '...' : value);

    for (const [method, path, field] of flagFields) {
        describe(`${method.toUpperCase()} ${path} ${field}`, () => {
            const schema = { [field]: findRoute(method, path).validationObjs.requestBody[field] };
            const removal = field === 'removeFlags';

            it('accepts custom keywords', () => {
                const flags = ['MyFlag', '$Forwarded', '$label1', 'Junk_Score-7', 'a'.repeat(255)];
                const validated = validatePart('requestBody', schema, { [field]: flags });
                expect(validated.error).not.to.exist;
                expect(validated.value[field]).to.deep.equal(flags);
            });

            for (const flag of ['\\Recent', '\\Custom', '\\', '\\Seenx', '\\Se', '\\*', '', '$wdlabel$507f1f77bcf86cd799439011', '$WDLabel$x']) {
                it(`refuses ${label(flag)}`, () => {
                    const validated = validatePart('requestBody', schema, { [field]: [flag] });
                    expect(validated.error).to.exist;
                });
            }

            for (const flag of ['\\Seen', '\\Flagged', '\\Draft', '\\Deleted', '\\Answered', '\\seen', '\\DELETED', '\\aNsWeReD']) {
                it(`accepts the system flag ${label(flag)}`, () => {
                    const validated = validatePart('requestBody', schema, { [field]: [flag, 'MyFlag'] });
                    expect(validated.error).not.to.exist;
                    expect(validated.value[field]).to.deep.equal([flag, 'MyFlag']);
                });
            }

            for (const flag of legacyKeywords) {
                it(`${removal ? 'accepts' : 'refuses'} the keyword ${label(flag)} that is not a valid IMAP atom`, () => {
                    const validated = validatePart('requestBody', schema, { [field]: [flag] });
                    if (removal) {
                        expect(validated.error).not.to.exist;
                    } else {
                        expect(validated.error).to.exist;
                    }
                });
            }

            it('refuses duplicate entries', () => {
                const validated = validatePart('requestBody', schema, { [field]: ['MyFlag', 'MyFlag'] });
                expect(validated.error).to.exist;
            });
        });
    }

    describe('system flags in PUT update requests', () => {
        for (const [path, extra] of [
            [messagePath, { message: '1' }],
            [messagesPath, { message: '1:3' }]
        ]) {
            describe(`PUT ${path}`, () => {
                const put = body => call('put', path, { ...ids, ...extra, ...body });

                it('maps addFlags \\Seen onto seen=true and keeps the custom flags', async () => {
                    const res = await put({ addFlags: ['\\Seen', 'MyFlag'] });
                    expect(res.status).to.equal(200);
                    expect(handled.updates).to.have.lengthOf(1);
                    expect(handled.updates[0]).to.include({ seen: true });
                    expect(handled.updates[0].addFlags).to.deep.equal(['MyFlag']);
                });

                it('maps removeFlags \\Seen onto seen=false', async () => {
                    const res = await put({ removeFlags: ['\\Seen'] });
                    expect(res.status).to.equal(200);
                    expect(handled.updates[0]).to.include({ seen: false });
                    expect(handled.updates[0].removeFlags).to.deep.equal([]);
                });

                it('maps \\Flagged, \\Draft and \\Deleted in either list', async () => {
                    const res = await put({ addFlags: ['\\Flagged', '\\Draft'], removeFlags: ['\\Deleted', 'Old'] });
                    expect(res.status).to.equal(200);
                    expect(handled.updates[0]).to.include({ flagged: true, draft: true, deleted: false });
                    expect(handled.updates[0].addFlags).to.deep.equal([]);
                    expect(handled.updates[0].removeFlags).to.deep.equal(['Old']);
                });

                it('passes \\Answered on as a plain flag', async () => {
                    const res = await put({ addFlags: ['\\Answered'] });
                    expect(res.status).to.equal(200);
                    expect(handled.updates[0].addFlags).to.deep.equal(['\\Answered']);
                    for (const field of ['seen', 'flagged', 'draft', 'deleted']) {
                        expect(handled.updates[0]).not.to.have.property(field);
                    }
                });

                it('moves with the same mapping', async () => {
                    const res = await put({ moveTo: new ObjectId().toString(), addFlags: ['\\Seen', 'MyFlag'], removeFlags: ['\\Flagged'] });
                    expect(res.status).to.equal(200);
                    expect(handled.updates).to.have.lengthOf(0);
                    expect(handled.moves).to.have.lengthOf(1);
                    expect(handled.moves[0]).to.include({ seen: true, flagged: false });
                    expect(handled.moves[0].addFlags).to.deep.equal(['MyFlag']);
                });

                for (const body of [
                    { addFlags: ['\\Seen'], seen: false },
                    { removeFlags: ['\\Seen'], seen: true },
                    { addFlags: ['\\Flagged'], flagged: false },
                    { removeFlags: ['\\Flagged'], flagged: true },
                    { addFlags: ['\\Draft'], draft: false },
                    { removeFlags: ['\\Deleted'], deleted: true },
                    { addFlags: ['\\Seen'], removeFlags: ['\\Seen'] },
                    { addFlags: ['\\seen'], removeFlags: ['\\SEEN'] },
                    { addFlags: ['\\Deleted'], removeFlags: ['\\Deleted'] }
                ]) {
                    it(`answers 400 for ${JSON.stringify(body)}`, async () => {
                        const res = await put({ ...body, moveTo: new ObjectId().toString() });
                        expect(res.status).to.equal(400);
                        expect(res.body.code).to.equal('InputValidationError');
                        expect(handled.updates).to.have.lengthOf(0);
                        expect(handled.moves).to.have.lengthOf(0);
                    });
                }

                it('accepts a system flag that agrees with the explicit value', async () => {
                    const res = await put({ addFlags: ['\\Seen'], seen: true });
                    expect(res.status).to.equal(200);
                    expect(handled.updates[0]).to.include({ seen: true });
                });

                it('refuses \\Recent', async () => {
                    const res = await put({ addFlags: ['\\Recent'] });
                    expect(res.status).to.equal(400);
                    expect(handled.updates).to.have.lengthOf(0);
                });

                it('treats \\Draft in addFlags like draft=true for updateThread', async () => {
                    const res = await put({ addFlags: ['\\Draft'], updateThread: true });
                    expect(res.status).to.equal(400);
                    expect(res.body.error).to.match(/updateThread can not be combined with the following per message values: draft/);
                    expect(handled.updates).to.have.lengthOf(0);
                });
            });
        }
    });

    describe('system flags in message upload flags', () => {
        const upload = body => call('post', messagesPath, { ...ids, raw: Buffer.from('From: a@example.com\r\nSubject: x\r\n\r\nbody\r\n'), ...body });

        it('uploads a seen message by default', async () => {
            const res = await upload({});
            expect(res.status).to.equal(200);
            expect(handled.adds[0].flags).to.deep.equal(['\\Seen']);
        });

        it('maps \\Seen and \\Flagged onto unseen=false and flagged=true without duplicate flags', async () => {
            const res = await upload({ flags: ['\\Seen', '\\Flagged', 'MyFlag'] });
            expect(res.status).to.equal(200);
            expect(handled.adds[0].flags).to.have.members(['\\Seen', '\\Flagged', 'MyFlag']);
            expect(handled.adds[0].flags).to.have.lengthOf(3);
        });

        it('accepts flags that agree with explicit values', async () => {
            const res = await upload({ flags: ['\\Seen', '\\Flagged'], unseen: false, flagged: true });
            expect(res.status).to.equal(200);
            expect(handled.adds[0].flags).to.have.members(['\\Seen', '\\Flagged']);
            expect(handled.adds[0].flags).to.have.lengthOf(2);
        });

        it('keeps \\Deleted and \\Answered in the stored flags, from which the message derives undeleted', async () => {
            const res = await upload({ flags: ['\\Deleted', '\\Answered'] });
            expect(res.status).to.equal(200);
            expect(handled.adds[0].flags).to.have.members(['\\Seen', '\\Deleted', '\\Answered']);
        });

        it('uploads an unseen message with unseen=true and no \\Seen flag', async () => {
            const res = await upload({ flags: ['\\Flagged'], unseen: true });
            expect(res.status).to.equal(200);
            expect(handled.adds[0].flags).to.deep.equal(['\\Flagged']);
        });

        for (const body of [
            { flags: ['\\Seen'], unseen: true },
            { flags: ['\\Flagged'], flagged: false },
            { flags: ['\\Draft'], draft: false }
        ]) {
            it(`answers 400 for ${JSON.stringify(body)}`, async () => {
                const res = await upload(body);
                expect(res.status).to.equal(400);
                expect(res.body.code).to.equal('InputValidationError');
                expect(handled.adds).to.have.lengthOf(0);
            });
        }

        it('refuses \\Recent', async () => {
            const res = await upload({ flags: ['\\Recent'] });
            expect(res.status).to.equal(400);
            expect(handled.adds).to.have.lengthOf(0);
        });
    });

    describe('system flag helpers', () => {
        it('returns changes without flag lists as they are', () => {
            const changes = { seen: true };
            expect(resolveSystemFlagChanges(changes)).to.equal(changes);
            expect(resolveSystemFlagChanges(undefined)).to.equal(undefined);
        });

        it('does not modify its input', () => {
            const changes = { addFlags: ['\\Seen', 'A'] };
            const resolved = resolveSystemFlagChanges(changes);
            expect(changes).to.deep.equal({ addFlags: ['\\Seen', 'A'] });
            expect(resolved).to.deep.equal({ addFlags: ['A'], seen: true });
        });

        it('treats a keyword named like an Object.prototype property as a keyword', () => {
            const values = resolveUploadFlags({ flags: ['constructor', 'toString'] }, () => false);
            expect(values.flags).to.deep.equal(['constructor', 'toString']);
        });
    });

    it('declares flags in the message listing and message response models', () => {
        const listing = findRoute('get', '/users/:user/mailboxes/:mailbox/messages').validationObjs.response[200].model;
        expect(listing.properties.results.items.properties.flags).to.include({ type: 'array' });

        const search = findRoute('get', '/users/:user/search').validationObjs.response[200].model;
        expect(search.properties.results.items.properties.flags).to.include({ type: 'array' });

        const message = findRoute('get', '/users/:user/mailboxes/:mailbox/messages/:message').validationObjs.response[200].model;
        expect(message.properties.flags).to.include({ type: 'array' });
    });
});
