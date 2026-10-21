/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, global-require: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');

const eventsPath = require.resolve('../lib/events');
const messageHandlerPath = require.resolve('../lib/message-handler');
const imapNotifierPath = require.resolve('../lib/imap-notifier');

function loadModulesWithPublishStub(published) {
    delete require.cache[messageHandlerPath];
    delete require.cache[imapNotifierPath];

    const events = require(eventsPath);
    const originalPublish = events.publish;

    events.publish = (redis, data) => {
        published.push(data);
        return Promise.resolve();
    };

    delete require.cache[messageHandlerPath];
    delete require.cache[imapNotifierPath];

    const MessageHandler = require('../lib/message-handler');
    const ImapNotifier = require('../lib/imap-notifier');

    return {
        MessageHandler,
        ImapNotifier,
        MARKED_HAM: events.MARKED_HAM,
        restore() {
            events.publish = originalPublish;
            delete require.cache[messageHandlerPath];
            delete require.cache[imapNotifierPath];
        }
    };
}

describe('MessageHandler message updates', function () {
    function buildHandler(MessageHandler, checkUpdate, messageOverrides) {
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const message = new ObjectId();
        const thread = new ObjectId();

        let nextCalls = 0;
        let notified = [];
        let fires = 0;
        let quotaUpdates = [];
        let calls = {
            mailboxFinds: 0,
            mailboxUpdates: 0,
            messageUpdates: 0,
            labelLookups: 0,
            labelInserts: 0
        };
        const atomicFlags = messageOverrides?.atomicFlags ?? messageOverrides?.flags ?? [];
        const labelRecords = new Map();
        const getLabelRecord = name => {
            if (!labelRecords.has(name)) {
                labelRecords.set(name, { _id: new ObjectId(), user, name });
            }
            return labelRecords.get(name);
        };
        const messageLabels = (messageOverrides?.labelNames || []).map(name => getLabelRecord(name)._id);
        const atomicLabels = (messageOverrides?.atomicLabelNames ?? messageOverrides?.labelNames ?? []).map(name => getLabelRecord(name)._id);

        let handler = Object.create(MessageHandler.prototype);
        handler.redis = false;
        handler.loggelf = () => false;
        handler.users = {
            collection(name) {
                expect(name).to.equal('users');
                return {
                    findOneAndUpdate(query, update) {
                        quotaUpdates.push(update.$inc.storageUsed);
                        return Promise.resolve({ value: { storageUsed: update.$inc.storageUsed } });
                    }
                };
            }
        };
        handler.settingsHandler = {
            get: () => Promise.resolve(100)
        };
        handler.notifier = {
            async addEntriesAsync(mailboxData, entries) {
                notified.push(...entries);
            },
            fire() {
                fires++;
            }
        };
        handler.database = {
            collection(name) {
                switch (name) {
                    case 'mailboxes':
                        return {
                            async findOneAndUpdate(query, update) {
                                calls.mailboxUpdates++;
                                expect(query._id.toString()).to.equal(mailbox.toString());
                                expect(query.user.toString()).to.equal(user.toString());
                                expect(update.$inc.modifyIndex).to.equal(1);
                                return {
                                    value: {
                                        _id: mailbox,
                                        user,
                                        modifyIndex: 7
                                    }
                                };
                            },
                            async findOne(query) {
                                calls.mailboxFinds++;
                                expect(query._id.toString()).to.equal(mailbox.toString());
                                expect(query.user.toString()).to.equal(user.toString());
                                return {
                                    _id: mailbox,
                                    user,
                                    modifyIndex: 7
                                };
                            }
                        };

                    case 'messages':
                        return {
                            async distinct() {
                                return atomicLabels;
                            },
                            find(query) {
                                expect(query.mailbox.toString()).to.equal(mailbox.toString());
                                expect(query.uid).to.equal(42);

                                return {
                                    project(projection) {
                                        expect(projection._id).to.be.true;
                                        expect(projection.uid).to.be.true;

                                        // a one message cursor
                                        return {
                                            async next() {
                                                if (nextCalls++) {
                                                    return null;
                                                }
                                                return {
                                                    _id: message,
                                                    uid: 42,
                                                    size: 1000,
                                                    envelope: ['Mon, 24 Aug 2026 09:00:00 +0000', 'subject'],
                                                    mimeTree: {
                                                        header: ['From: sender@example.com', 'Date: Mon, 24 Aug 2026 09:00:00 +0000 (GMT)']
                                                    },
                                                    ...messageOverrides,
                                                    labels: messageLabels
                                                };
                                            },
                                            async close() {},
                                            async *[Symbol.asyncIterator]() {
                                                let doc;
                                                while ((doc = await this.next()) !== null) {
                                                    yield doc;
                                                }
                                            }
                                        };
                                    }
                                };
                            },
                            async findOneAndUpdate(query, update, options) {
                                calls.messageUpdates++;
                                expect(query._id.toString()).to.equal(message.toString());
                                expect(query.mailbox.toString()).to.equal(mailbox.toString());
                                expect(query.uid).to.equal(42);
                                expect(options.returnDocument).to.equal('before');
                                if (checkUpdate) {
                                    checkUpdate(update);
                                } else {
                                    expect(update.$set.flagged).to.be.true;
                                    expect(update.$set.modseq).to.equal(7);
                                    expect(update.$addToSet.flags.$each).to.deep.equal(['\\Flagged']);
                                }

                                return {
                                    value: {
                                        _id: message,
                                        uid: 42,
                                        thread,
                                        flags: atomicFlags,
                                        labels: atomicLabels
                                    }
                                };
                            }
                        };

                    case 'labels':
                        calls.labelLookups++;
                        return {
                            async insertOne() {
                                calls.labelInserts++;
                                return { acknowledged: true, insertedId: new ObjectId() };
                            },
                            find(query) {
                                const names = query.name?.$in;
                                const records = names
                                    ? names.map(getLabelRecord)
                                    : query._id?.$in
                                      ? query._id.$in.map(id => [...labelRecords.values()].find(record => record._id.equals(id))).filter(Boolean)
                                      : [...labelRecords.values()];
                                return {
                                    async toArray() {
                                        return records;
                                    }
                                };
                            }
                        };

                    default:
                        throw new Error('Unexpected collection lookup: ' + name);
                }
            }
        };

        return { handler, user, mailbox, message, notified, fires: () => fires, quotaUpdates, calls, getLabelRecord };
    }

    function updateAsync(handler, user, mailbox, changes) {
        return new Promise((resolve, reject) => {
            handler.update(user, mailbox, 42, changes, (err, updated) => {
                if (err) {
                    return reject(err);
                }
                return resolve(updated);
            });
        });
    }

    it('publishes marked.ham when a message is starred', async function () {
        const published = [];
        const { MessageHandler, MARKED_HAM, restore } = loadModulesWithPublishStub(published);

        try {
            const { handler, user, mailbox, message, notified, calls } = buildHandler(MessageHandler);

            let updated = await updateAsync(handler, user, mailbox, {
                flagged: true
            });

            expect(updated).to.equal(1);
            expect(calls.mailboxUpdates).to.equal(1);
            expect(calls.messageUpdates).to.equal(1);
            expect(notified).to.have.lengthOf(1);
            expect(published).to.have.lengthOf(1);
            expect(published[0].ev).to.equal(MARKED_HAM);
            expect(published[0].user).to.equal(user.toString());
            expect(published[0].mailbox).to.equal(mailbox.toString());
            expect(published[0].message).to.equal(message.toString());
            expect(published[0].id).to.equal(42);
        } finally {
            restore();
        }
    });

    it('updates every stored Date representation and notifies mailbox clients', async function () {
        const MessageHandler = require('../lib/message-handler');
        const sendTime = new Date('2026-08-25T12:00:00.000Z');
        const { handler, user, mailbox, notified, fires, quotaUpdates, calls } = buildHandler(MessageHandler, update => {
            expect(update.$set.hdate).to.equal(sendTime);
            // parsed headers store the raw header value, not a Date object
            expect(update.$set['mimeTree.parsedHeader.date']).to.equal('Tue, 25 Aug 2026 12:00:00 +0000');
            expect(update.$set['mimeTree.header']).to.deep.equal(['From: sender@example.com', 'Date: Tue, 25 Aug 2026 12:00:00 +0000']);
            expect(update.$set.envelope).to.deep.equal(['Tue, 25 Aug 2026 12:00:00 +0000', 'subject']);
            // the replaced Date line is 6 bytes shorter than the stored one
            expect(update.$set.size).to.equal(994);
            expect(update.$set.modseq).to.equal(7);
        });

        let updated = await updateAsync(handler, user, mailbox, {
            date: sendTime
        });

        expect(updated).to.equal(1);
        expect(calls.mailboxUpdates).to.equal(1);
        expect(calls.messageUpdates).to.equal(1);
        expect(notified).to.have.lengthOf(1);
        expect(notified[0].command).to.equal('FETCH');
        expect(notified[0].uid).to.equal(42);
        // carried over to the search index, which otherwise only tracks flag changes
        expect(notified[0].hdate).to.equal(sendTime);
        expect(fires()).to.equal(1);
        // the stored message got smaller, so the quota must follow
        expect(quotaUpdates).to.deep.equal([-6]);
    });

    it('adds a Date header to a message that does not have one', async function () {
        const MessageHandler = require('../lib/message-handler');
        const sendTime = new Date('2026-08-25T12:00:00.000Z');
        const { handler, user, mailbox, quotaUpdates } = buildHandler(
            MessageHandler,
            update => {
                expect(update.$set['mimeTree.header']).to.deep.equal(['From: sender@example.com', 'Date: Tue, 25 Aug 2026 12:00:00 +0000']);
                // the added header line plus the CRLF that joins it to the previous line
                expect(update.$set.size).to.equal(1039);
            },
            { mimeTree: { header: ['From: sender@example.com'] } }
        );

        let updated = await updateAsync(handler, user, mailbox, { date: sendTime });

        expect(updated).to.equal(1);
        expect(quotaUpdates).to.deep.equal([39]);
    });

    it('rejects an invalid date without applying a partial update', async function () {
        const MessageHandler = require('../lib/message-handler');
        const { handler, user, mailbox, calls } = buildHandler(MessageHandler);

        let err;
        try {
            await updateAsync(handler, user, mailbox, { date: 'not a date' });
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(err.message).to.equal('Invalid date value');
        expect(calls.mailboxUpdates).to.equal(0);
        expect(calls.messageUpdates).to.equal(0);
    });

    it('leaves the quota alone when the message has no stored size', async function () {
        const MessageHandler = require('../lib/message-handler');
        const { handler, user, mailbox, quotaUpdates } = buildHandler(
            MessageHandler,
            update => {
                expect(update.$set).not.to.have.property('size');
            },
            { size: undefined }
        );

        let updated = await updateAsync(handler, user, mailbox, { date: new Date('2026-08-25T12:00:00.000Z') });

        expect(updated).to.equal(1);
        expect(quotaUpdates).to.deep.equal([]);
    });

    it('uses literal label arrays in aggregation updates', async function () {
        const MessageHandler = require('../lib/message-handler');
        let labelId;
        const { handler, user, mailbox, getLabelRecord } = buildHandler(
            MessageHandler,
            update => {
                expect(update).to.be.an('array').with.lengthOf(1);
                expect(update[0].$set.flags.$setUnion[1]).to.deep.equal({ $literal: ['\\Seen'] });
                expect(update[0].$set.labels.$setUnion[0].$literal).to.deep.equal([labelId]);
                expect(update[0].$set['meta.custom']).to.deep.equal({ $literal: { label: '$flags' } });
            },
            { flags: ['\\Seen', '$Forwarded'], labelNames: ['old-label'] }
        );
        labelId = getLabelRecord('valid$Label')._id;

        let updated = await updateAsync(handler, user, mailbox, {
            seen: true,
            labels: ['valid$Label'],
            metaData: { label: '$flags' }
        });

        expect(updated).to.equal(1);
    });

    it('uses one aggregation update when adding and removing system flags together', async function () {
        const MessageHandler = require('../lib/message-handler');
        const { handler, user, mailbox } = buildHandler(
            MessageHandler,
            update => {
                expect(update).to.be.an('array').with.lengthOf(1);
                expect(update[0].$set.flags.$setUnion[1]).to.deep.equal({ $literal: ['\\Seen'] });
                expect(update[0].$set.flags.$setUnion[0].$filter.cond.$not.$in[1]).to.deep.equal({ $literal: ['\\Flagged'] });
            },
            { flags: ['\\Flagged'] }
        );

        let updated = await updateAsync(handler, user, mailbox, {
            seen: true,
            flagged: false
        });

        expect(updated).to.equal(1);
    });

    it('adds custom flags with addFlags', async function () {
        const MessageHandler = require('../lib/message-handler');
        const { handler, user, mailbox, notified, calls } = buildHandler(
            MessageHandler,
            update => {
                expect(update.$addToSet.flags.$each).to.deep.equal(['MyFlag', '$label1']);
                expect(update.$set.modseq).to.equal(7);
                expect(update).not.to.have.property('$pull');
            },
            { flags: ['\\Seen'] }
        );

        let updated = await updateAsync(handler, user, mailbox, {
            addFlags: ['MyFlag', '$label1']
        });

        expect(updated).to.equal(1);
        expect(calls.mailboxUpdates).to.equal(1);
        expect(notified[0].flags).to.deep.equal(['\\Seen', 'MyFlag', '$label1']);
        expect(notified[0].unseenChange).to.be.false;
    });

    it('removes custom flags with removeFlags', async function () {
        const MessageHandler = require('../lib/message-handler');
        const { handler, user, mailbox, notified } = buildHandler(
            MessageHandler,
            update => {
                expect(update.$pull.flags.$in).to.deep.equal(['MyFlag']);
                expect(update).not.to.have.property('$addToSet');
            },
            { flags: ['\\Seen', 'MyFlag', 'Other'] }
        );

        let updated = await updateAsync(handler, user, mailbox, {
            removeFlags: ['MyFlag']
        });

        expect(updated).to.equal(1);
        expect(notified[0].flags).to.deep.equal(['\\Seen', 'Other']);
    });

    it('uses one aggregation update when adding and removing custom flags together, keeping a flag listed in both', async function () {
        const MessageHandler = require('../lib/message-handler');
        const { handler, user, mailbox, notified } = buildHandler(
            MessageHandler,
            update => {
                // $addToSet and $pull on the same path in one update is a MongoDB conflict
                expect(update).to.be.an('array').with.lengthOf(1);
                expect(update[0].$set.flags.$setUnion[0].$filter.cond.$not.$in[1]).to.deep.equal({ $literal: ['\\Flagged', 'Old', 'Both'] });
                expect(update[0].$set.flags.$setUnion[1]).to.deep.equal({ $literal: ['New', 'Both'] });
            },
            { flags: ['\\Flagged', 'Old', 'Both'] }
        );

        let updated = await updateAsync(handler, user, mailbox, {
            flagged: false,
            addFlags: ['New', 'Both'],
            removeFlags: ['Old', 'Both']
        });

        expect(updated).to.equal(1);
        expect(notified[0].flags).to.deep.equal(['New', 'Both']);
        expect(notified[0].flaggedChangedTo).to.be.false;
    });

    describe('system flags in addFlags and removeFlags', function () {
        const MessageHandler = require('../lib/message-handler');

        // runs an update and returns what was written to the message and notified
        async function run(changes, messageOverrides) {
            let written;
            const built = buildHandler(
                MessageHandler,
                update => {
                    written = update;
                },
                messageOverrides
            );
            const updated = await updateAsync(built.handler, built.user, built.mailbox, changes);
            return { ...built, updated, written };
        }

        it('marks a message seen with addFlags \\Seen the way seen=true does', async function () {
            const viaFlags = await run({ addFlags: ['\\Seen'] }, { flags: [] });
            const viaField = await run({ seen: true }, { flags: [] });

            expect(viaFlags.updated).to.equal(1);
            expect(viaFlags.written).to.deep.equal(viaField.written);
            // derived field, flag and a new modseq are written together
            expect(viaFlags.written.$set.unseen).to.be.false;
            expect(viaFlags.written.$set.modseq).to.equal(7);
            expect(viaFlags.written.$addToSet.flags.$each).to.deep.equal(['\\Seen']);
            // the mailbox gets its modseq and the unseen counter is adjusted from the notification
            expect(viaFlags.calls.mailboxUpdates).to.equal(1);
            expect(viaFlags.notified).to.have.lengthOf(1);
            expect(viaFlags.notified[0].unseenChange).to.be.true;
            expect(viaFlags.notified[0].flags).to.deep.equal(['\\Seen']);
            expect(viaFlags.notified[0].unseenChange).to.equal(viaField.notified[0].unseenChange);
            expect(viaFlags.notified[0].flags).to.deep.equal(viaField.notified[0].flags);
        });

        it('marks a message unseen with removeFlags \\Seen the way seen=false does', async function () {
            const viaFlags = await run({ removeFlags: ['\\Seen'] }, { flags: ['\\Seen', 'Keep'] });
            const viaField = await run({ seen: false }, { flags: ['\\Seen', 'Keep'] });

            expect(viaFlags.written).to.deep.equal(viaField.written);
            expect(viaFlags.written.$set.unseen).to.be.true;
            expect(viaFlags.written.$pull.flags.$in).to.deep.equal(['\\Seen']);
            expect(viaFlags.written).not.to.have.property('$addToSet');
            expect(viaFlags.notified[0].unseenChange).to.be.true;
            expect(viaFlags.notified[0].flags).to.deep.equal(['Keep']);
        });

        it('maps every field backed system flag to its field in both lists', async function () {
            const cases = [
                ['\\Seen', 'unseen', add => !add],
                ['\\Flagged', 'flagged', add => add],
                ['\\Draft', 'draft', add => add],
                ['\\Deleted', 'undeleted', add => !add]
            ];

            for (const [flag, derived, expected] of cases) {
                for (const add of [true, false]) {
                    const { written } = await run(add ? { addFlags: [flag] } : { removeFlags: [flag] }, { flags: add ? [] : [flag] });
                    expect(written.$set[derived], `${add ? 'add' : 'remove'} ${flag}`).to.equal(expected(add));
                    expect(add ? written.$addToSet.flags.$each : written.$pull.flags.$in).to.deep.equal([flag]);
                }
            }
        });

        it('accepts the system flags in any letter case', async function () {
            const { written } = await run({ addFlags: ['\\seen', '\\FLAGGED'] }, { flags: [] });

            expect(written.$set.unseen).to.be.false;
            expect(written.$set.flagged).to.be.true;
            expect(written.$addToSet.flags.$each).to.have.members(['\\Seen', '\\Flagged']);
        });

        it('handles system flags mixed with custom flags in one update', async function () {
            const { written, notified } = await run({ addFlags: ['\\Seen', 'MyFlag'], removeFlags: ['\\Flagged', 'Old'] }, { flags: ['\\Flagged', 'Old'] });

            // adding and removing in one update needs the aggregation form
            expect(written).to.be.an('array').with.lengthOf(1);
            expect(written[0].$set.unseen).to.deep.equal({ $literal: false });
            expect(written[0].$set.flagged).to.deep.equal({ $literal: false });
            expect(written[0].$set.flags.$setUnion[0].$filter.cond.$not.$in[1].$literal).to.have.members(['\\Flagged', 'Old']);
            expect(written[0].$set.flags.$setUnion[1].$literal).to.have.members(['\\Seen', 'MyFlag']);
            expect(notified[0].flags).to.have.members(['\\Seen', 'MyFlag']);
            expect(notified[0].unseenChange).to.be.true;
            expect(notified[0].flaggedChangedTo).to.be.false;
        });

        it('stores \\Answered as a plain flag without touching derived fields', async function () {
            const { written, notified } = await run({ addFlags: ['\\Answered'] }, { flags: ['\\Seen'] });

            expect(written.$addToSet.flags.$each).to.deep.equal(['\\Answered']);
            expect(written.$set).to.have.all.keys('modseq');
            expect(notified[0].unseenChange).to.be.false;

            const removal = await run({ removeFlags: ['\\Answered'] }, { flags: ['\\Answered'] });
            expect(removal.written.$pull.flags.$in).to.deep.equal(['\\Answered']);
            expect(removal.written.$set).to.have.all.keys('modseq');
        });

        it('accepts a system flag that agrees with the explicit field', async function () {
            const { written } = await run({ addFlags: ['\\Seen'], seen: true }, { flags: [] });

            expect(written.$set.unseen).to.be.false;
            expect(written.$addToSet.flags.$each).to.deep.equal(['\\Seen']);
        });

        it('rejects contradictions before anything is written', async function () {
            const contradictions = [
                { addFlags: ['\\Seen'], seen: false },
                { removeFlags: ['\\Seen'], seen: true },
                { addFlags: ['\\Flagged'], flagged: false },
                { removeFlags: ['\\Draft'], draft: true },
                { addFlags: ['\\Deleted'], deleted: false },
                { addFlags: ['\\Seen'], removeFlags: ['\\Seen'] },
                { addFlags: ['\\seen'], removeFlags: ['\\SEEN'] },
                { addFlags: ['\\Deleted'], removeFlags: ['\\Deleted'] }
            ];

            for (const changes of contradictions) {
                const { handler, user, mailbox, calls } = buildHandler(MessageHandler);
                let error;
                try {
                    await updateAsync(handler, user, mailbox, changes);
                } catch (err) {
                    error = err;
                }

                expect(error, JSON.stringify(changes)).to.exist;
                expect(error.responseCode).to.equal(400);
                expect(error.code).to.equal('InputValidationError');
                expect(calls.mailboxUpdates).to.equal(0);
                expect(calls.messageUpdates).to.equal(0);
            }
        });

        it('rejects contradictions before creating labels or touching the labels collection', async function () {
            const contradictions = [
                { addLabels: ['NewLabel'], addFlags: ['\\Seen'], seen: false },
                { labels: ['NewLabel'], removeFlags: ['\\Flagged'], flagged: true },
                { addLabels: ['NewLabel'], addFlags: ['\\Seen'], removeFlags: ['\\Seen'] }
            ];

            for (const changes of contradictions) {
                const { handler, user, mailbox, calls } = buildHandler(MessageHandler);
                let error;
                try {
                    await updateAsync(handler, user, mailbox, changes);
                } catch (err) {
                    error = err;
                }

                expect(error, JSON.stringify(changes)).to.exist;
                expect(error.code).to.equal('InputValidationError');
                expect(calls.labelInserts).to.equal(0);
                expect(calls.labelLookups).to.equal(0);
                expect(calls.mailboxUpdates).to.equal(0);
                expect(calls.messageUpdates).to.equal(0);
            }
        });

        it('still creates labels when system flags agree with the explicit field', async function () {
            const { handler, user, mailbox, calls } = buildHandler(MessageHandler, () => {}, { flags: [] });
            await updateAsync(handler, user, mailbox, { addLabels: ['NewLabel'], addFlags: ['\\Seen'], seen: true });
            expect(calls.labelLookups).to.be.greaterThan(0);
            expect(calls.messageUpdates).to.equal(1);
        });
    });

    it('treats empty addFlags and removeFlags as nothing to change', async function () {
        const MessageHandler = require('../lib/message-handler');
        const { handler, user, mailbox, calls } = buildHandler(MessageHandler);

        let error;
        try {
            await updateAsync(handler, user, mailbox, { addFlags: [], removeFlags: [] });
        } catch (err) {
            error = err;
        }

        expect(error).to.exist;
        expect(error.code).to.equal('NothingChanged');
        expect(calls.mailboxUpdates).to.equal(0);
        expect(calls.messageUpdates).to.equal(0);
    });

    it('keeps API labels separate from ordinary IMAP flags in notifications', async function () {
        const MessageHandler = require('../lib/message-handler');
        const { handler, user, mailbox, notified, getLabelRecord } = buildHandler(MessageHandler, () => false, {
            flags: ['ordinary-imap-flag'],
            labelNames: ['concurrent-label'],
            atomicLabelNames: ['concurrent-label']
        });

        let updated = await updateAsync(handler, user, mailbox, {
            addLabels: ['concurrent-label']
        });

        expect(updated).to.equal(1);
        expect(notified).to.have.lengthOf(1);
        expect(notified[0].flags).to.deep.equal(['ordinary-imap-flag', `$wdlabel$${getLabelRecord('concurrent-label')._id}`]);
        expect(notified[0].addedLabels).to.deep.equal([]);
        expect(notified[0].removedLabels).to.deep.equal([]);
    });

    it('does not add or remove the reserved forwarded marker as a label', async function () {
        const MessageHandler = require('../lib/message-handler');
        const { handler, user, mailbox, notified, getLabelRecord } = buildHandler(
            MessageHandler,
            update => {
                expect(update[0].$set).not.to.have.property('flags');
            },
            { flags: ['$Forwarded'], labelNames: ['old-label'] }
        );

        let updated = await updateAsync(handler, user, mailbox, {
            labels: ['$Forwarded', 'visible-label'],
            removeLabels: ['$Forwarded']
        });

        expect(updated).to.equal(1);
        expect(notified[0].flags).to.deep.equal(['$Forwarded', `$wdlabel$${getLabelRecord('visible-label')._id}`]);
        expect(notified[0].addedLabels).to.deep.equal(['visible-label']);
        expect(notified[0].removedLabels).to.deep.equal(['old-label']);
    });

    it('hides deleting labels from flag notifications and reports active labels on seen changes', async function () {
        const MessageHandler = require('../lib/message-handler');
        const setup = buildHandler(
            MessageHandler,
            update => {
                expect(update.$set.unseen).to.be.false;
                expect(update.$addToSet.flags.$each).to.deep.equal(['\\Seen']);
            },
            { flags: [], labelNames: ['Active', 'Deleting'] }
        );
        setup.getLabelRecord('Deleting').deleting = true;

        await updateAsync(setup.handler, setup.user, setup.mailbox, { seen: true });

        expect(setup.notified).to.have.lengthOf(1);
        expect(setup.notified[0].flags).to.deep.equal(['\\Seen', `$wdlabel$${setup.getLabelRecord('Active')._id}`]);
        expect(setup.notified[0].labels).to.deep.equal(['Active']);
    });

    it('publishes marked.ham when markHam=true is the only requested action', async function () {
        const published = [];
        const { MessageHandler, MARKED_HAM, restore } = loadModulesWithPublishStub(published);

        try {
            const { handler, user, mailbox, message, notified, calls } = buildHandler(MessageHandler);

            let updated = await updateAsync(handler, user, mailbox, {
                markHam: true
            });

            expect(updated).to.equal(1);
            expect(calls.mailboxFinds).to.equal(1);
            expect(calls.mailboxUpdates).to.equal(0);
            expect(calls.messageUpdates).to.equal(0);
            expect(notified).to.be.empty;
            expect(published).to.have.lengthOf(1);
            expect(published[0].ev).to.equal(MARKED_HAM);
            expect(published[0].user).to.equal(user.toString());
            expect(published[0].mailbox).to.equal(mailbox.toString());
            expect(published[0].message).to.equal(message.toString());
            expect(published[0].id).to.equal(42);
        } finally {
            restore();
        }
    });

    it('marks moved message notifications as ham when the move also stars the message', async function () {
        const MessageHandler = require('../lib/message-handler');
        const user = new ObjectId();
        const sourceMailbox = new ObjectId();
        const targetMailbox = new ObjectId();
        const sourceMessage = new ObjectId();
        const insertedMessage = new ObjectId();
        const thread = new ObjectId();
        const existsEntries = [];
        const removeEntries = [];

        let handler = Object.create(MessageHandler.prototype);
        handler.database = {
            collection(name) {
                expect(name).to.equal('messages');
                return {
                    insertOne(message) {
                        expect(message.mailbox.toString()).to.equal(targetMailbox.toString());
                        return Promise.resolve({
                            acknowledged: true,
                            insertedId: insertedMessage
                        });
                    },
                    deleteOne(query) {
                        expect(query._id.toString()).to.equal(sourceMessage.toString());
                        expect(query.mailbox.toString()).to.equal(sourceMailbox.toString());
                        expect(query.uid).to.equal(41);
                        return Promise.resolve({
                            deletedCount: 1
                        });
                    }
                };
            }
        };

        await handler.updateMessage(
            {
                message: {
                    mailbox: targetMailbox,
                    unseen: false,
                    flags: ['\\Flagged', 'new-label'],
                    idate: new Date(),
                    thread
                },
                targetData: {
                    _id: targetMailbox
                },
                sourceUid: [],
                destinationUid: [],
                mailboxData: {
                    _id: sourceMailbox,
                    user
                },
                existsEntries,
                removeEntries,
                messageId: sourceMessage,
                messageUid: 41,
                unseen: true,
                flagged: false,
                labels: ['old-label'],
                destinationLabels: ['new-label'],
                newModseq: 3,
                uidNext: 42,
                junk: false,
                bulk_batch_size: 100
            },
            {
                close: () => Promise.resolve()
            },
            {
                updates: {
                    flagged: true
                }
            }
        );

        expect(existsEntries).to.have.lengthOf(1);
        expect(existsEntries[0].markHam).to.be.true;
        expect(existsEntries[0].uid).to.equal(42);
        expect(existsEntries[0].message.toString()).to.equal(insertedMessage.toString());
        expect(existsEntries[0].flagged).to.be.true;
        expect(existsEntries[0].labels).to.deep.equal(['new-label']);
        expect(removeEntries[0].unseen).to.be.true;
        expect(removeEntries[0].flagged).to.be.false;
        expect(removeEntries[0].labels).to.deep.equal(['old-label']);
    });
});

describe('ImapNotifier marked.ham events', function () {
    it('publishes markHam entries after addEntries enriches user and mailbox fields', async function () {
        const published = [];
        const { ImapNotifier, MARKED_HAM, restore } = loadModulesWithPublishStub(published);
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const message = new ObjectId();
        let journalEntries;

        let notifier = Object.create(ImapNotifier.prototype);
        notifier.redis = false;
        notifier.updateCounters = entries => {
            expect(entries).to.equal(journalEntries);
            return Promise.resolve();
        };
        notifier.logger = {
            debug() {},
            error() {}
        };
        notifier.database = {
            collection(name) {
                expect(name).to.equal('journal');
                return {
                    insertMany(entries) {
                        journalEntries = entries;
                        return Promise.resolve({
                            insertedCount: entries.length
                        });
                    }
                };
            }
        };

        try {
            let insertedCount = await notifier.addEntriesAsync(
                {
                    _id: mailbox,
                    user,
                    modifyIndex: 10
                },
                {
                    command: 'EXISTS',
                    uid: 42,
                    message,
                    markHam: true,
                    modseq: 99
                }
            );

            expect(insertedCount).to.equal(1);
            expect(journalEntries).to.have.lengthOf(1);
            expect(journalEntries[0].user.toString()).to.equal(user.toString());
            expect(journalEntries[0].mailbox.toString()).to.equal(mailbox.toString());
            expect(published).to.deep.equal([
                {
                    ev: MARKED_HAM,
                    user: user.toString(),
                    mailbox: mailbox.toString(),
                    message: message.toString(),
                    id: 42
                }
            ]);
        } finally {
            restore();
        }
    });
});
