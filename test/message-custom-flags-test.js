/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const registerMessages = require('../lib/api/messages');
const { prepareSearchFilter } = require('../lib/prepare-search-filter');
const { compileRouteValidator } = require('../lib/fastify/validation');
require('../lib/schemas/json-schemas'); // registers the shared wd:* schemas

// validates one request part on its own, the way the merged route validator sees it
const validatePart = (part, schema, input) => compileRouteValidator({ [part]: schema })(input);

describe('Message custom IMAP flags over the API', () => {
    const routes = [];
    // captures native fastify route registrations: server.route({method, url, config, handler})
    const server = {
        route(options) {
            routes.push({ method: options.method.toLowerCase(), path: options.url, validationObjs: options.config.validationObjs });
        },
        get() {},
        post() {},
        put() {},
        delete() {}
    };
    const database = {
        collection() {
            return {};
        }
    };
    registerMessages({ database, senderDb: database }, server, { put() {}, update() {} }, {}, {}, {});
    const findRoute = (method, path) => routes.find(route => route.method === method && route.path === path);

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

            for (const flag of ['\\Seen', '\\Custom', '', '$wdlabel$507f1f77bcf86cd799439011', '$WDLabel$x']) {
                it(`refuses ${label(flag)}`, () => {
                    const validated = validatePart('requestBody', schema, { [field]: [flag] });
                    expect(validated.error).to.exist;
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

    it('declares flags in the message listing and message response models', () => {
        const listing = findRoute('get', '/users/:user/mailboxes/:mailbox/messages').validationObjs.response[200].model;
        expect(listing.properties.results.items.properties.flags).to.include({ type: 'array' });

        const search = findRoute('get', '/users/:user/search').validationObjs.response[200].model;
        expect(search.properties.results.items.properties.flags).to.include({ type: 'array' });

        const message = findRoute('get', '/users/:user/mailboxes/:mailbox/messages/:message').validationObjs.response[200].model;
        expect(message.properties.flags).to.include({ type: 'array' });
    });
});
