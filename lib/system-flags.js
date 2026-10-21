'use strict';

// System flags in the API flag lists (flags, addFlags, removeFlags).
//
// \Seen, \Flagged, \Draft and \Deleted are mirrored in derived message fields (unseen, flagged, draft,
// undeleted) that drive search, mailbox counters, modseq and IMAP notifications. Writing them straight
// into messages.flags would leave those fields stale, so a flag list entry is converted into the
// matching seen/flagged/draft/deleted value and takes the same code path as that field. \Answered has no
// derived field or counter, it is an ordinary stored flag like a keyword.

// lowercase system flag -> field that owns it
const FIELD_FLAGS = new Map([
    ['\\seen', { flag: '\\Seen', field: 'seen' }],
    ['\\flagged', { flag: '\\Flagged', field: 'flagged' }],
    ['\\draft', { flag: '\\Draft', field: 'draft' }],
    ['\\deleted', { flag: '\\Deleted', field: 'deleted' }]
]);

// canonical spelling of the system flags that may be listed, stored the way STORE and APPEND store them
const LISTABLE_FLAGS = new Map([...FIELD_FLAGS.values()].map(entry => [entry.flag.toLowerCase(), entry.flag]).concat([['\\answered', '\\Answered']]));

// source of the JSON Schema pattern matching the system flags above in any letter case
const LISTABLE_FLAGS_PATTERN =
    '\\\\(?:' +
    [...LISTABLE_FLAGS.values()]
        .map(flag =>
            [...flag.slice(1)]
                .map(c => `[${c.toUpperCase()}${c.toLowerCase()}]`)
                .join('')
        )
        .join('|') +
    ')';

const inputError = message => {
    const err = new Error(message);
    err.responseCode = 400;
    err.code = 'InputValidationError';
    return err;
};

// canonical spelling of a listable system flag, any other value is returned unchanged
const canonicalFlag = flag => (typeof flag === 'string' && LISTABLE_FLAGS.get(flag.toLowerCase())) || flag;

const uniqueFlags = flags => [...new Set(flags.map(canonicalFlag))];

/**
 * Converts system flags in addFlags and removeFlags of an update into the seen/flagged/draft/deleted values
 *
 * `\Seen` in addFlags means `seen: true` and in removeFlags `seen: false`, and likewise for \Flagged,
 * \Draft and \Deleted. Those flags are removed from the lists, so what is left is custom keywords and
 * \Answered. Throws a 400 error if a flag is listed in both lists or contradicts an explicit value.
 *
 * @param {Object} changes Requested message changes
 * @returns {Object} The same object if it lists no flags, otherwise a copy with the flags resolved
 */
const resolveSystemFlagChanges = changes => {
    if (!changes || (!Array.isArray(changes.addFlags) && !Array.isArray(changes.removeFlags))) {
        return changes;
    }

    const resolved = { ...changes };
    const addFlags = uniqueFlags([].concat(changes.addFlags || []));
    const removeFlags = uniqueFlags([].concat(changes.removeFlags || []));
    const requested = new Map();

    for (const [list, state, name] of [
        [addFlags, true, 'addFlags'],
        [removeFlags, false, 'removeFlags']
    ]) {
        for (const flag of list) {
            const entry = FIELD_FLAGS.get(typeof flag === 'string' ? flag.toLowerCase() : '');
            if (!entry) {
                continue;
            }

            if (requested.has(entry.field)) {
                throw inputError(`${entry.flag} can not be listed in both addFlags and removeFlags`);
            }
            requested.set(entry.field, state);

            if (typeof changes[entry.field] === 'boolean' && changes[entry.field] !== state) {
                throw inputError(`${name} ${entry.flag} contradicts ${entry.field}=${changes[entry.field]}`);
            }
            resolved[entry.field] = state;
        }
    }

    if (Array.isArray(changes.addFlags)) {
        resolved.addFlags = addFlags.filter(flag => !FIELD_FLAGS.has(flag.toLowerCase()));
    }
    if (Array.isArray(changes.removeFlags)) {
        resolved.removeFlags = removeFlags.filter(flag => !FIELD_FLAGS.has(flag.toLowerCase()));
    }

    return resolved;
};

/**
 * Converts system flags in the flags of an uploaded message into the unseen/flagged/draft values
 *
 * `\Seen` means `unseen: false`, `\Flagged` means `flagged: true` and `\Draft` means `draft: true`. The
 * three values default to a seen, unflagged, non draft message, so they only contradict a flag if the
 * request set them. \Deleted and \Answered stay in the list, the stored message derives `undeleted` from
 * \Deleted the same way IMAP APPEND does.
 *
 * @param {Object} values Validated request values, the unseen/flagged/draft values and flags are updated
 * @param {Function} isExplicit Tells if the request itself, and not a default, set a value
 * @returns {Object} The updated values
 */
const resolveUploadFlags = (values, isExplicit) => {
    if (!Array.isArray(values.flags)) {
        return values;
    }

    // a Map, as a keyword may be named like an Object.prototype property
    const wanted = new Map([
        ['\\Seen', ['unseen', false]],
        ['\\Flagged', ['flagged', true]],
        ['\\Draft', ['draft', true]]
    ]);
    const flags = [];

    for (const flag of uniqueFlags(values.flags)) {
        const target = wanted.get(flag);
        if (!target) {
            flags.push(flag);
            continue;
        }

        const [field, state] = target;
        if (isExplicit(field) && values[field] !== state) {
            throw inputError(`flags ${flag} contradicts ${field}=${values[field]}`);
        }
        values[field] = state;
    }

    values.flags = flags;
    return values;
};

module.exports = { LISTABLE_FLAGS_PATTERN, resolveSystemFlagChanges, resolveUploadFlags };
