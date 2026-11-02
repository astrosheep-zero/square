import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { validateOwner, nameKey, type Owner } from './neutral.js';
import { isWakeRouteKind, validateMessageMetadata, type JsonValue, type WakeAddress } from './channel-values.js';
import type { ChannelRead, ChannelWrite, MessageFact, MessageAddressFact, MessageFilter, MessageDraft, EndpointFact, EndpointRef, ReceiveClaimFact, ChannelDeliveryEvidence, ChannelDeliveryClaimInput, ChannelDeliveryClaimResult, ChannelDeliveryPreparation, ChannelDeliveryCompletion } from './channel-ports.js';
import { validateMetadataMatch, matchingDeferrals, validateDeferralId, type MetadataMatch, type DeliveryDeferralFact } from './delivery-deferral.js';
import { claimAttempt, prepareAttempt, settleAttempt, type Attempt, type AttemptRows } from './delivery-attempts.js';
import { receive, recordConsumed } from './receive.js';
import { formatMessageId, parseMessageId, validateEndpointGeneration, type MessageId, type EndpointGeneration } from './message.js';
import { compileSearchPattern } from './search.js';
import { readStorageRevision } from './sqlite-framing.js';
import { type Row, encode, key, invalidArtifact, requireFact, integer, finite, string, json, object, shape, decoded, immutable, stableJson, pageRows, pageLimit } from './sqlite-values.js';
function message(row: Row): MessageFact {
    const index = integer(row.msg_index), at = finite(row.at);
    const from = decoded(row.from_json, true);
    requireFact(row.from_key_json === key(from));
    const metadata = row.metadata_json === null ? undefined : validateMessageMetadata(json(row.metadata_json));
    return immutable({ index, at, from, body: decoded(row.body_json),
        ...(metadata === undefined ? {} : { metadata }),
        ...(row.preview === null || row.preview === undefined ? {} : { preview: string(row.preview, true) }) });
}
export function messageAddress(row: Row): MessageAddressFact {
    const recipient = decoded(row.recipient_json, true);
    requireFact(row.recipient_key_json === key(recipient), 'message address identity is malformed.');
    integer(row.msg_index);
    integer(row.recipient_order);
    const generation = row.generation_json === null ? undefined : endpointGeneration(decoded(row.generation_json, true));
    return immutable({ recipient, ...(generation === undefined ? {} : { generation }) });
}
export function endpointGeneration(value: unknown): EndpointGeneration {
    try { return validateEndpointGeneration(value); }
    catch { throw invalidArtifact('endpoint generation is malformed.'); }
}
function messageId(value: unknown): MessageId {
    requireFact(typeof value === 'string' && parseMessageId(value) !== undefined, 'message id is malformed.');
    return value as MessageId;
}
function wakeAddress(value: unknown): WakeAddress {
    const address = shape(value, ['kind', 'address']);
    requireFact(isWakeRouteKind(address.kind));
    const entries = object(address.address);
    requireFact(Object.values(entries).every((item) => typeof item === 'string'));
    stableJson(entries);
    return immutable({ kind: address.kind, address: entries as Record<string, string> });
}
function ownerFrom(row: Row, column = 'owner_json'): Owner {
    const owner = decoded(row[column], true);
    validateOwner(owner);
    return owner;
}
export function endpoint(row: Row): EndpointFact {
    const participant = decoded(row.participant_json, true);
    requireFact(row.participant_key_json === key(participant));
    const generation = endpointGeneration(decoded(row.generation_json, true));
    const parsedWake = row.wake_address_json === null ? undefined : wakeAddress(json(row.wake_address_json));
    requireFact(row.attachment === 'attached' || row.attachment === 'detached', 'endpoint attachment is malformed.');
    requireFact(row.attachment !== 'detached' || parsedWake === undefined, 'a detached endpoint has a wake address.');
    return immutable({ participant, owner: ownerFrom(row), generation, attachment: row.attachment, ...(parsedWake === undefined ? {} : { wakeAddress: parsedWake }) });
}
function nativeCorrelation(value: unknown): NonNullable<ChannelDeliveryEvidence['correlation']> {
    const item = shape(value, ['harness'], ['token', 'messageId', 'payloadHash']);
    requireFact(['claude', 'opencode', 'pi'].includes(string(item.harness)));
    for (const key of ['token', 'messageId', 'payloadHash']) if (Object.hasOwn(item, key)) string(item[key], true);
    return immutable({ harness: item.harness as 'claude' | 'opencode' | 'pi',
        ...(item.token === undefined ? {} : { token: item.token as string }),
        ...(item.messageId === undefined ? {} : { messageId: item.messageId as string }),
        ...(item.payloadHash === undefined ? {} : { payloadHash: item.payloadHash as string }) });
}
export function deliveryEvidence(row: Row, payload = object(json(row.payload_json))): ChannelDeliveryEvidence {
    const participant = decoded(row.participant_json, true);
    requireFact(row.participant_key_json === key(participant));
    const generation = endpointGeneration(decoded(row.generation_json, true));
    const id = messageId(formatMessageId(integer(row.msg_index)));
    requireFact(['wake', 'presentation'].includes(string(row.kind)) && ['dispatching', 'accepted', 'failed', 'unknown', 'released', 'presented', 'clipped'].includes(string(row.outcome)));
    requireFact(Number.isSafeInteger(row.attempt_n) && (row.attempt_n as number) >= 0);
    const nativeObservations = payload.nativeObservations === undefined ? undefined : (() => {
        requireFact(Array.isArray(payload.nativeObservations));
        return payload.nativeObservations.map((value) => {
            const item = shape(value, ['eventId', 'messageId', 'state', 'observedAt'], ['reason']);
            requireFact(['held', 'released', 'dropped'].includes(string(item.state)));
            return {
                eventId: string(item.eventId, true), messageId: string(item.messageId, true),
                state: item.state as 'held' | 'released' | 'dropped',
                ...(Object.hasOwn(item, 'reason') ? { reason: string(item.reason) } : {}), observedAt: finite(item.observedAt),
            };
        });
    })();
    const coverage = payload.coverage === undefined ? undefined : (() => { requireFact(payload.coverage === 'full' || payload.coverage === 'clipped'); return payload.coverage as 'full' | 'clipped'; })();
    return immutable({
        participant, generation, message: id, kind: row.kind as ChannelDeliveryEvidence['kind'],
        outcome: row.outcome as ChannelDeliveryEvidence['outcome'], attemptN: integer(row.attempt_n), at: finite(row.at),
        ...(row.expires_at === null ? {} : { expiresAt: finite(row.expires_at) }),
        ...(row.claim_token_json === null ? {} : { claimToken: decoded(row.claim_token_json, true) }),
        ...(payload.route === undefined ? {} : { route: wakeAddress(payload.route) }),
        ...(payload.signature === undefined ? {} : { signature: string(payload.signature) }),
        ...(payload.message === undefined ? {} : { messageText: string(payload.message) }),
        ...(payload.diagnostic === undefined ? {} : { diagnostic: payload.diagnostic as JsonValue }),
        ...(payload.correlation === undefined ? {} : { correlation: nativeCorrelation(payload.correlation) }),
        ...(coverage === undefined ? {} : { coverage }),
        ...(payload.description === undefined ? {} : { description: string(payload.description) }),
        ...(nativeObservations === undefined ? {} : { nativeObservations }),
    });
}
export function deliveryDeferral(row: Row): DeliveryDeferralFact {
    const participant = decoded(row.participant_json, true);
    requireFact(row.participant_key_json === key(participant));
    const generation = endpointGeneration(decoded(row.generation_json, true));
    const id = validateDeferralId(decoded(row.deferral_id_json, true));
    const match = validateMetadataMatch(json(row.match_json));
    requireFact(encode(match) === row.match_json, 'delivery deferral match encoding is malformed.');
    return immutable({ participant, generation, id, match, expiresAt: finite(row.expires_at) });
}
export function receiveClaim(row: Row): ReceiveClaimFact {
    const owner = decoded(row.owner_key_json, true), namespace = decoded(row.namespace_key_json, true);
    const generation = endpointGeneration(decoded(row.generation_json, true));
    const suppressed = json(row.suppressed_json);
    requireFact(Array.isArray(suppressed) && suppressed.every(value => Number.isSafeInteger(value) && (value as number) >= 0), 'receive claim coverage is malformed.');
    return immutable({ namespace, id: decoded(row.claim_id_json, true), owner, generation,
        selector: json(row.selector_json) as JsonValue, suppressed: suppressed as number[],
        heartbeatAt: finite(row.heartbeat_at), expiresAt: finite(row.expires_at) });
}
interface Selection {
    sql: string;
    args: SQLInputValue[];
}
function messageSelection(filter: MessageFilter, alias = 'm'): Selection {
    const terms: string[] = [], args: SQLInputValue[] = [];
    const add = (sql: string, value: SQLInputValue) => {
        terms.push(sql);
        args.push(value);
    };
    if (filter.afterIndex !== undefined)
        add(`${alias}.msg_index > ?`, integer(filter.afterIndex, -1));
    if (filter.beforeIndex !== undefined)
        add(`${alias}.msg_index < ?`, integer(filter.beforeIndex));
    if (filter.throughIndex !== undefined)
        add(`${alias}.msg_index <= ?`, integer(filter.throughIndex, -1));
    if (filter.afterAt !== undefined)
        add(`${alias}.at > ?`, finite(filter.afterAt));
    for (const [column, values] of [['msg_index', filter.indexes], [filter.senderMatch === 'exact' ? 'from_json' : 'from_key_json', filter.senders?.map(name => filter.senderMatch === 'exact' ? encode(name) : key(name))]] as const) {
        if (values !== undefined) {
            if (column === 'msg_index')
                values.forEach(v => integer(v));
            add(`${alias}.${column} IN (SELECT value FROM json_each(?))`, encode(values));
        }
    }
    if (filter.metadataMatch !== undefined) {
        terms.push(`NOT EXISTS (
            SELECT 1 FROM json_each(?) field WHERE NOT EXISTS (
                WITH RECURSIVE walk(value,type,depth) AS (
                    SELECT json_extract(${alias}.metadata_json,'$'),json_type(${alias}.metadata_json,'$'),0
                    UNION ALL
                    SELECT child.value,child.type,walk.depth+1
                    FROM walk JOIN json_each(CASE WHEN walk.type='object' THEN walk.value ELSE '{}' END) child
                      ON child.key=json_extract(field.value,'$.path['||walk.depth||']')
                    WHERE walk.depth<json_array_length(field.value,'$.path')
                )
                SELECT 1 FROM walk WHERE depth=json_array_length(field.value,'$.path')
                  AND (type=json_type(field.value,'$.equals')
                    OR type IN ('integer','real') AND json_type(field.value,'$.equals') IN ('integer','real'))
                  AND value IS json_extract(field.value,'$.equals')
            )
        )`);
        args.push(encode(filter.metadataMatch.fields));
    }
    if (filter.search !== undefined) {
        terms.push(`square_search(?,?,'msg/'||${alias}.msg_index,${alias}.from_json,json_extract(${alias}.body_json,'$'))=1`);
        args.push(filter.search.mode, filter.search.text);
    }
    return { sql: terms.length ? terms.join(' AND ') : '1', args };
}
export function createChannelSqlite(db: DatabaseSync): ChannelWrite & { readonly changed: boolean; readonly deliveryChanged: boolean } {
    let changed = false, deliveryChanged = false;
    const all = (sql: string, args: readonly SQLInputValue[] = []): Row[] => db.prepare(sql).all(...args) as Row[];
    const one = (sql: string, args: readonly SQLInputValue[] = []): Row | undefined => db.prepare(sql).get(...args) as Row | undefined;
    const run = (sql: string, args: readonly SQLInputValue[] = []): number => Number(db.prepare(sql).run(...args).changes);
    let searchRegistered = false;
    function ensureSearch(): void {
        if (searchRegistered) return;
        const patterns = new Map<string, RegExp>();
        db.function('square_search', { deterministic: true }, (mode, text, index, actor, body) => {
            const cacheKey = encode([mode, text]);
            let pattern = patterns.get(cacheKey);
            if (pattern === undefined) {
                pattern = compileSearchPattern(string(text), mode === 'literal');
                patterns.set(cacheKey, pattern);
            }
            return Number([string(index), decoded(actor, true), body === null ? '' : string(body)]
                .some(field => pattern.test(field)));
        });
        searchRegistered = true;
    }
    function selectMessage(filter: MessageFilter): Selection {
        if (filter.search !== undefined) ensureSearch();
        return messageSelection(filter);
    }
    const channel = {} as ChannelWrite;
    function currentEndpoint(name: string): EndpointFact | undefined {
        const r = one('SELECT * FROM endpoints WHERE participant_key_json=?', [key(name)]);
        return r ? endpoint(r) : undefined;
    }
    function owner(requested: string): string {
        const current = currentEndpoint(requested);
        if (current !== undefined) return current.participant;
        const historical = one('SELECT recipient_json FROM message_addresses WHERE recipient_key_json=? ORDER BY msg_index LIMIT 1', [key(requested)]);
        return historical === undefined ? requested : decoded(historical.recipient_json, true);
    }

    function directedSelection(recipient: string, filter: MessageFilter): Selection {
        const endpoint = currentEndpoint(recipient), canonical = endpoint?.participant ?? recipient, base = selectMessage(filter);
        base.sql += ' AND ma.recipient_key_json=?';
        base.args.push(key(canonical));
        if (filter.currentGeneration) {
            base.sql += ' AND (ma.generation_json IS NULL OR ma.generation_json=?)';
            base.args.push(endpoint === undefined ? encode('') : encode(endpoint.generation));
        }
        if (filter.unseenOnly) {
            base.sql += ' AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.owner_key_json=? AND r.msg_index=m.msg_index)';
            base.args.push(encode(canonical));
        }
        return base;
    }

    // ----- Lower Channel capabilities -----
    const channelRead: ChannelRead = {
        header() {
            const rows = all('SELECT m.*, (SELECT COALESCE(MAX(msg_index),-1) FROM messages) AS last_msg_index FROM channel_meta m');
            requireFact(rows.length === 1 && rows[0].id === 1, 'header row is malformed.');
            const r = rows[0], nextMessageIndex = integer(r.next_msg_index), lastMessageIndex = integer(r.last_msg_index, -1);
            requireFact(nextMessageIndex > lastMessageIndex, 'nextMessageIndex is behind the message history.');
            return immutable({ revision: readStorageRevision(db), deliveryRevision: readStorageRevision(db, true), nextMessageIndex, lastMessageIndex });
        },
        message(index) { const r = one('SELECT * FROM messages WHERE msg_index=?', [integer(index)]); return r ? message(r) : undefined; },
        messages(indexes) {
            indexes.forEach(v => integer(v));
            return immutable(all('SELECT * FROM messages WHERE msg_index IN (SELECT value FROM json_each(?)) ORDER BY msg_index', [encode(indexes)]).map(message));
        },
        messageHeads(filter, page) {
            const s = selectMessage(filter), limit = pageLimit(page);
            return pageRows(all(`SELECT m.* FROM messages m WHERE ${s.sql} ORDER BY m.msg_index ${page.edge === 'newest' ? 'DESC' : 'ASC'} LIMIT ?`, [...s.args, limit]), page, message) as never;
        },
        messageCount(filter) { const s = selectMessage(filter); return integer(one(`SELECT COUNT(*) AS n FROM messages m WHERE ${s.sql}`, s.args)!.n); },
        addresses(index) {
            return immutable(all('SELECT * FROM message_addresses WHERE msg_index=? ORDER BY recipient_order', [integer(index)]).map(messageAddress));
        },
        receipt(name, index) { const r = one('SELECT at FROM receipts WHERE owner_key_json=? AND msg_index=?', [encode(owner(name)), integer(index)]); return r ? immutable({ at: finite(r.at) }) : undefined; },
        receiptFacts(name, afterIndex) {
            const k = encode(owner(name));
            const r = one('SELECT MAX(at) AS latest FROM receipts WHERE owner_key_json=?', [k])!;
            const e = one(`SELECT MAX(r.msg_index) AS latest FROM receipts r JOIN messages m ON m.msg_index=r.msg_index WHERE r.owner_key_json=? AND r.msg_index>?`, [k, integer(afterIndex, -1)])!;
            return immutable({ ...(r.latest === null ? {} : { latestAt: finite(r.latest) }), ...(e.latest === null ? {} : { latestActorMessageIndex: integer(e.latest) }) });
        },
        directed(recipient, filter, page) {
            const base = directedSelection(recipient, filter), limit = pageLimit(page);
            const rows = all(`SELECT m.*,ma.recipient_json,ma.generation_json FROM messages m JOIN message_addresses ma ON ma.msg_index=m.msg_index WHERE ${base.sql} ORDER BY m.msg_index ${page.edge === 'newest' ? 'DESC' : 'ASC'} LIMIT ?`, [...base.args, limit]);
            return pageRows(rows, page, r => ({ index: integer(r.msg_index), at: finite(r.at), from: decoded(r.from_json, true),
                recipient: decoded(r.recipient_json, true), ...(r.generation_json === null ? {} : { generation: endpointGeneration(decoded(r.generation_json, true)) }) })) as never;
        },
        directedCount(recipient, filter) {
            const base = directedSelection(recipient, filter);
            return integer(one(`SELECT COUNT(*) AS n FROM messages m JOIN message_addresses ma ON ma.msg_index=m.msg_index WHERE ${base.sql}`, base.args)!.n);
        },
        endpoint(name) { return currentEndpoint(name); },
        endpointsForOwner(requested) {
            validateOwner(requested);
            return immutable(all('SELECT * FROM endpoints WHERE owner_json=? ORDER BY participant_key_json', [encode(requested)]).map(endpoint));
        },
        endpoints() { return immutable(all('SELECT * FROM endpoints ORDER BY participant_key_json').map(endpoint)); },
        deliveryEvidence(participant, generation, activity) {
            const args: SQLInputValue[] = [key(participant), encode(endpointGeneration(generation))];
            const filter = activity === undefined ? '' : ' AND msg_index=?';
            if (activity !== undefined) {
                const resolved = parseMessageId(activity);
                requireFact(resolved !== undefined, 'message id is malformed.');
                args.push(resolved);
            }
            return immutable(all(`SELECT * FROM delivery_evidence WHERE participant_key_json=? AND generation_json=?${filter} ORDER BY msg_index,kind,attempt_n`, args).map(row => deliveryEvidence(row)));
        },
        deliveryByToken(claimToken) { const row = one('SELECT * FROM delivery_evidence WHERE claim_token_json=?', [encode(claimToken)]); return row === undefined ? undefined : deliveryEvidence(row); },
        cancelledThrough(participant, generation) {
            const r = one('SELECT through_index FROM delivery_cancellations WHERE participant_key_json=? AND generation_json=?', [key(participant), encode(endpointGeneration(generation))]);
            return r === undefined ? undefined : integer(r.through_index, -1);
        },
        deliveryDeferrals(name, generation) {
            const canonical = owner(name), current = currentEndpoint(canonical);
            if (current === undefined || current.generation !== generation) return [];
            return immutable(all('SELECT * FROM delivery_deferrals WHERE participant_key_json=? AND generation_json=? ORDER BY expires_at,deferral_id_json', [key(canonical), encode(generation)]).map(deliveryDeferral));
        },
        receiveClaims(name, namespace) {
            const canonical = owner(name), args: SQLInputValue[] = [encode(canonical)];
            let where = 'owner_key_json=?';
            if (namespace !== undefined) { where += ' AND namespace_key_json=?'; args.push(encode(namespace)); }
            return immutable(all(`SELECT * FROM receive_claims WHERE ${where} ORDER BY namespace_key_json`, args).map(receiveClaim));
        },
        claimLease(name, namespace) { return channelRead.receiveClaims(name, namespace)[0]; },
        suppressed(name, generation, index, now) {
            integer(index); finite(now); endpointGeneration(generation);
            const rows = all('SELECT * FROM receive_claims WHERE owner_key_json=? AND expires_at>?', [encode(owner(name)), now]);
            return rows.some(row => {
                const claim = receiveClaim(row);
                return claim.generation === generation && claim.suppressed.includes(index);
            });
        },
    };

    function writeMessage(draft: MessageDraft): MessageFact {
        const from = string(draft.from, true), body = string(draft.body);
        requireFact(Array.isArray(draft.to), 'message addresses are malformed.');
        const next = integer(one('SELECT next_msg_index FROM channel_meta WHERE id=1')!.next_msg_index);
        requireFact(next < Number.MAX_SAFE_INTEGER, 'message index is exhausted.');
        const metadata = draft.metadata === undefined ? undefined : validateMessageMetadata(draft.metadata);
        if (draft.preview !== undefined) string(draft.preview, true);
        const seen = new Set<string>();
        const audience = draft.to.flatMap(address => {
            const recipient = string(address.recipient, true);
            if (seen.has(nameKey(recipient))) return [];
            seen.add(nameKey(recipient));
            return [{ recipient, via: address }];
        });
        receive({
            insertItem: () => { run('INSERT INTO messages(msg_index,at,from_json,from_key_json,body_json,metadata_json,preview) VALUES(?,?,?,?,?,?,?)',
                [next, finite(draft.at), encode(from), key(from), encode(body), metadata === undefined ? null : encode(metadata), draft.preview ?? null]); },
            insertAddress: (index, { recipient, via }, order) => { run('INSERT INTO message_addresses(msg_index,recipient_key_json,recipient_json,recipient_order,generation_json) VALUES(?,?,?,?,?)',
                [index, key(recipient), encode(recipient), order, via.generation === undefined ? null : encode(endpointGeneration(via.generation))]); },
        }, { item: { key: next, data: draft }, audience });
        run('UPDATE channel_meta SET next_msg_index=? WHERE id=1', [next + 1]);
        changed = true;
        return message(one('SELECT * FROM messages WHERE msg_index=?', [next])!);
    }
    function endpointMatches(current: EndpointFact | undefined, expected: EndpointRef): current is EndpointFact {
        return current !== undefined && current.owner === expected.owner && current.generation === expected.generation;
    }
    function deleteEndpointClaims(name: string): void {
        run('DELETE FROM receive_claims WHERE owner_key_json=?', [encode(name)]);
        run('DELETE FROM delivery_deferrals WHERE participant_key_json=?', [key(name)]);
    }
    const channelWrite = Object.assign({}, channelRead, {
        publishMessage: writeMessage,
        storeEndpoint(value: EndpointFact) {
            validateOwner(value.owner); endpointGeneration(value.generation); string(value.participant, true);
            const existing = currentEndpoint(value.participant);
            if (existing !== undefined && stableJson(existing) === stableJson(value)) return false;
            run('INSERT INTO endpoints(participant_key_json,participant_json,owner_json,generation_json,wake_address_json,attachment) VALUES(?,?,?,?,?,?) ON CONFLICT(participant_key_json) DO UPDATE SET participant_json=excluded.participant_json,owner_json=excluded.owner_json,generation_json=excluded.generation_json,wake_address_json=excluded.wake_address_json,attachment=excluded.attachment',
                [key(value.participant), encode(value.participant), encode(value.owner), encode(value.generation), value.wakeAddress === undefined ? null : encode(value.wakeAddress), value.attachment]);
            deleteEndpointClaims(value.participant);
            deliveryChanged = true;
            return true;
        },
        updateWakeAddress(value: EndpointRef, wakeAddress?: WakeAddress) {
            if (wakeAddress !== undefined) { requireFact(isWakeRouteKind(wakeAddress.kind)); requireFact(Object.values(wakeAddress.address).every((item) => typeof item === 'string')); }
            const current = one('SELECT wake_address_json FROM endpoints WHERE participant_key_json=? AND generation_json=?', [key(value.participant), encode(value.generation)])!;
            if (stableJson(current.wake_address_json === null ? null : json(current.wake_address_json)) === stableJson(wakeAddress ?? null)) return false;
            const count = run('UPDATE endpoints SET wake_address_json=? WHERE participant_key_json=? AND generation_json=?', [wakeAddress === undefined ? null : encode(wakeAddress), key(value.participant), encode(value.generation)]);
            if (count) deliveryChanged = true;
            return count > 0;
        },
        reattachEndpoint(value: EndpointRef, address?: WakeAddress) {
            const current = currentEndpoint(value.participant);
            if (current?.attachment !== 'detached' || !endpointMatches(current, value)) return false;
            run("UPDATE endpoints SET attachment='attached',wake_address_json=? WHERE participant_key_json=? AND generation_json=?", [address === undefined ? null : encode(wakeAddress(address)), key(value.participant), encode(value.generation)]);
            deliveryChanged = true;
            return true;
        },
        detachEndpoint(value: EndpointRef) {
            const count = run("UPDATE endpoints SET attachment='detached',wake_address_json=NULL WHERE participant_key_json=? AND generation_json=? AND owner_json=? AND attachment='attached'", [key(value.participant), encode(value.generation), encode(value.owner)]);
            if (!count) return false;
            deleteEndpointClaims(value.participant);
            deliveryChanged = true;
            return true;
        },
        removeEndpoint(value: EndpointRef) {
            const current = currentEndpoint(value.participant);
            if (!endpointMatches(current, value)) return false;
            run('DELETE FROM endpoints WHERE participant_key_json=? AND generation_json=? AND owner_json=?', [key(value.participant), encode(value.generation), encode(value.owner)]);
            deleteEndpointClaims(value.participant);
            deliveryChanged = true;
            return true;
        },
        cancelThrough(value: EndpointRef, through: number) {
            endpointGeneration(value.generation); integer(through, -1);
            const prior = channelRead.cancelledThrough(value.participant, value.generation) ?? -1;
            if (through <= prior) return false;
            run('INSERT INTO delivery_cancellations(participant_key_json,generation_json,through_index) VALUES(?,?,?) ON CONFLICT(participant_key_json,generation_json) DO UPDATE SET through_index=excluded.through_index', [key(value.participant), encode(value.generation), through]);
            deliveryChanged = true;
            return true;
        },
        markSeen(name: string, indexes: readonly number[], at: number) {
            finite(at);
            const next = integer(one('SELECT next_msg_index FROM channel_meta WHERE id=1')!.next_msg_index);
            indexes.forEach(index => requireFact(integer(index) < next, 'receipt references an unassigned message index.'));
            const canonical = owner(name);
            string(canonical, true);
            const count = recordConsumed({
                insertReceipt: (ref, time) => run('INSERT OR IGNORE INTO receipts(owner_key_json,msg_index,at) VALUES(?,?,?)', [encode(ref.recipient), ref.item, time]) > 0,
            }, indexes.map(item => ({ recipient: canonical, item })), at);
            if (count) changed = true;
            return count;
        },
        putDeliveryDeferral(seatRef: EndpointRef, id: string, match: MetadataMatch, expiresAt: number, now: number) {
            finite(now); finite(expiresAt);
            const canonicalMatch = validateMetadataMatch(match);
            run('DELETE FROM delivery_deferrals WHERE participant_key_json=? AND expires_at<=?', [key(seatRef.participant), now]);
            run('INSERT INTO delivery_deferrals(participant_key_json,participant_json,generation_json,deferral_id_json,match_json,expires_at) VALUES(?,?,?,?,?,?)', [key(seatRef.participant), encode(seatRef.participant), encode(seatRef.generation), encode(id), encode(canonicalMatch), expiresAt]);
            deliveryChanged = true;
            return true;
        },
        renewDeliveryDeferral(seatRef: EndpointRef, id: string, expiresAt: number, now: number) {
            finite(now); finite(expiresAt);
            const pruned = run('DELETE FROM delivery_deferrals WHERE participant_key_json=? AND expires_at<=?', [key(seatRef.participant), now]);
            const count = run('UPDATE delivery_deferrals SET expires_at=? WHERE participant_key_json=? AND generation_json=? AND deferral_id_json=? AND expires_at>?', [expiresAt, key(seatRef.participant), encode(seatRef.generation), encode(id), now]);
            if (count || pruned) deliveryChanged = true;
            return count > 0;
        },
        releaseDeliveryDeferral(seatRef: EndpointRef, id: string, now: number) {
            finite(now);
            const pruned = run('DELETE FROM delivery_deferrals WHERE participant_key_json=? AND expires_at<=?', [key(seatRef.participant), now]);
            const count = run('DELETE FROM delivery_deferrals WHERE participant_key_json=? AND generation_json=? AND deferral_id_json=? AND expires_at>?', [key(seatRef.participant), encode(seatRef.generation), encode(id), now]);
            if (count || pruned) deliveryChanged = true;
            return count > 0;
        },
        putReceiveClaim(claim: ReceiveClaimFact) {
            string(claim.namespace, true); string(claim.id, true); string(claim.owner, true); endpointGeneration(claim.generation);
            finite(claim.heartbeatAt); finite(claim.expiresAt);
            requireFact(claim.expiresAt >= claim.heartbeatAt);
            requireFact(Array.isArray(claim.suppressed) && claim.suppressed.every(value => Number.isSafeInteger(value) && value >= 0), 'receive claim coverage is malformed.');
            const selector = stableJson(claim.selector), suppressed = stableJson([...new Set(claim.suppressed)].sort((a, b) => a - b));
            const previous = one('SELECT * FROM receive_claims WHERE namespace_key_json=? AND owner_key_json=?', [encode(claim.namespace), encode(claim.owner)]);
            const prior = previous === undefined ? undefined : receiveClaim(previous);
            if (prior !== undefined && prior.id === claim.id && stableJson(prior.selector) === selector
                && stableJson(prior.suppressed) === suppressed && prior.generation === claim.generation
                && prior.heartbeatAt === claim.heartbeatAt && prior.expiresAt === claim.expiresAt) return false;
            run('INSERT INTO receive_claims(namespace_key_json,owner_key_json,generation_json,claim_id_json,heartbeat_at,expires_at,selector_json,suppressed_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(namespace_key_json,owner_key_json) DO UPDATE SET generation_json=excluded.generation_json,claim_id_json=excluded.claim_id_json,heartbeat_at=excluded.heartbeat_at,expires_at=excluded.expires_at,selector_json=excluded.selector_json,suppressed_json=excluded.suppressed_json',
                [encode(claim.namespace), encode(claim.owner), encode(claim.generation), encode(claim.id), claim.heartbeatAt, claim.expiresAt, encode(claim.selector), suppressed]);
            changed = true;
            return true;
        },
        removeReceiveClaim(ownerName: string, namespace: string, id: string) {
            const count = run('DELETE FROM receive_claims WHERE namespace_key_json=? AND owner_key_json=? AND claim_id_json=?', [encode(namespace), encode(ownerName), encode(id)]);
            if (count) changed = true;
            return count > 0;
        },
    }) as unknown as ChannelWrite;
    Object.assign(channel, channelWrite);

    const lower = channelRead;
    type Payload = Record<string, unknown>;
    function attempt(row: Row): Attempt<Payload> {
        const data = object(json(row.payload_json)), evidence = deliveryEvidence(row, data);
        return { purpose: evidence.kind === 'wake' ? 'dispatch' : 'presentation', token: evidence.claimToken ?? '',
            ordinal: evidence.attemptN, outcome: evidence.outcome, at: evidence.at, expiresAt: evidence.expiresAt, data };
    }
    function attemptRows(seat: EndpointRef, index: number, kind: ChannelDeliveryEvidence['kind'], known?: Attempt<Payload>): AttemptRows<Payload> & { evidence(value: Attempt<Payload>): ChannelDeliveryEvidence } {
        const scope = [key(seat.participant), encode(seat.generation), index, kind];
        let sources: Row[] = [];
        return {
            list() { sources = all('SELECT * FROM delivery_evidence WHERE participant_key_json=? AND generation_json=? AND msg_index=? AND kind=? ORDER BY attempt_n DESC', scope); return sources.map(attempt); },
            evidence(value) { const source = sources.find(row => row.attempt_n === value.ordinal)!; return deliveryEvidence({ ...source, outcome: value.outcome, at: value.at, expires_at: value.expiresAt ?? null }, value.data); },
            byToken(token) {
                if (known?.token === token) return known;
                const row = one('SELECT * FROM delivery_evidence WHERE participant_key_json=? AND generation_json=? AND msg_index=? AND kind=? AND claim_token_json=?', [...scope, encode(token)]);
                return row === undefined ? undefined : attempt(row);
            },
            insert(value) {
                run('INSERT INTO delivery_evidence(participant_key_json,participant_json,generation_json,msg_index,kind,attempt_n,outcome,at,expires_at,claim_token_json,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                    [scope[0], encode(seat.participant), scope[1], index, kind, value.ordinal, value.outcome, value.at, value.expiresAt ?? null, encode(value.token), encode(value.data)]);
                deliveryChanged = true;
            },
            replace(value) {
                const count = run('UPDATE delivery_evidence SET outcome=?,at=?,expires_at=?,payload_json=? WHERE participant_key_json=? AND generation_json=? AND msg_index=? AND kind=? AND attempt_n=? AND claim_token_json IS ?',
                    [value.outcome, value.at, value.expiresAt ?? null, encode(value.data), ...scope, value.ordinal, value.token === '' ? null : encode(value.token)]);
                if (count) deliveryChanged = true;
            },
        };
    }
    const delivery = {
        claimDelivery(input: ChannelDeliveryClaimInput): ChannelDeliveryClaimResult {
            requireFact(input.kind === 'wake' || input.kind === 'presentation');
            const index = parseMessageId(input.message);
            requireFact(index !== undefined, 'message id is malformed.');
            finite(input.at);
            const leaseMs = integer(input.leaseMs, 1);
            string(input.claimToken, true);
            if (input.route !== undefined) wakeAddress(input.route);
            const currentSeat = currentEndpoint(input.seat.participant);
            if (currentSeat === undefined || currentSeat.attachment !== 'attached' || currentSeat.generation !== input.seat.generation || currentSeat.owner !== input.seat.owner
                || lower.directed(input.seat.participant, { afterIndex: index - 1, throughIndex: index, currentGeneration: true }, { edge: 'oldest', limit: 1 }).items.length === 0) return { status: 'stale' };
            const metadata = lower.message(index)?.metadata;
            if (matchingDeferrals(lower.deliveryDeferrals(currentSeat.participant, currentSeat.generation), metadata, input.at).length > 0) return { status: 'deferred' };
            const cancelledThrough = lower.cancelledThrough(input.seat.participant, input.seat.generation);
            if (cancelledThrough !== undefined && index <= cancelledThrough) return { status: 'stale' };
            const existing = lower.deliveryEvidence(input.seat.participant, input.seat.generation, formatMessageId(index));
            if (input.observationOf !== undefined) {
                if (input.kind !== 'presentation' || !existing.some(row => row.kind === 'wake'
                    && row.claimToken === input.observationOf && ['dispatching', 'accepted', 'unknown'].includes(row.outcome))) return { status: 'stale' };
            } else {
                const blocker = existing.find(row => row.kind !== input.kind && row.outcome !== 'failed' && row.outcome !== 'released');
                if (blocker !== undefined) {
                    if (blocker.outcome === 'dispatching' && blocker.expiresAt !== undefined && blocker.expiresAt <= input.at) {
                        // Normalize abandoned custody to unknown in the same transaction, never steal it.
                        const rows = attemptRows(input.seat, index, blocker.kind);
                        const normalized = { ...blocker, outcome: 'unknown' as const, at: input.at, expiresAt: undefined };
                        rows.replace({ purpose: blocker.kind === 'wake' ? 'dispatch' : 'presentation', token: blocker.claimToken ?? '', ordinal: blocker.attemptN,
                            outcome: 'unknown', at: input.at, data: {} });
                        return { status: 'terminal', evidence: normalized };
                    }
                    return { status: blocker.outcome === 'dispatching' ? 'busy' : 'terminal', evidence: blocker };
                }
            }
            const rows = attemptRows(input.seat, index, input.kind);
            const result = claimAttempt({ ...rows, replace(value) { rows.replace({ ...value, data: { ...value.data, diagnostic: 'interrupted dispatch' } }); } },
                { purpose: input.kind === 'wake' ? 'dispatch' : 'presentation', token: input.claimToken, at: input.at, leaseMs, data: input.route === undefined ? {} : { route: input.route } });
            if (result.status === 'acquired') return { status: 'acquired', claimToken: result.token, attemptN: result.ordinal };
            const evidence = result.interrupted ? { ...result.evidence, data: { ...result.evidence.data, diagnostic: 'interrupted dispatch' } } : result.evidence;
            return { status: result.status, evidence: rows.evidence(evidence) };
        },
        prepareDelivery(input: ChannelDeliveryPreparation): boolean {
            const row = one('SELECT * FROM delivery_evidence WHERE participant_key_json=? AND generation_json=? AND claim_token_json=?', [key(input.seat.participant), encode(input.seat.generation), encode(input.claimToken)]);
            if (row === undefined || row.outcome !== 'dispatching') return false;
            requireFact(input.coverage === 'full' || input.coverage === 'clipped');
            const previous = attempt(row), correlation = nativeCorrelation(input.correlation), payload = previous.data;
            if (stableJson(payload.correlation ?? null) === stableJson(correlation) && payload.coverage === input.coverage
                && stableJson(payload.description ?? null) === stableJson(input.description ?? null)) return true;
            return prepareAttempt(attemptRows(input.seat, integer(row.msg_index), row.kind as ChannelDeliveryEvidence['kind'], previous),
                { token: input.claimToken, data: { ...payload, correlation, coverage: input.coverage, ...(input.description === undefined ? {} : { description: input.description }) } });
        },
        completeDelivery(input: ChannelDeliveryCompletion): boolean {
            const index = parseMessageId(input.message);
            requireFact(index !== undefined, 'message id is malformed.');
            finite(input.at);
            requireFact(['accepted', 'failed', 'unknown', 'released', 'presented', 'clipped'].includes(input.outcome));
            string(input.claimToken, true);
            const row = one('SELECT * FROM delivery_evidence WHERE participant_key_json=? AND generation_json=? AND msg_index=? AND claim_token_json=?', [key(input.seat.participant), encode(input.seat.generation), index, encode(input.claimToken)]);
            if (row === undefined) return false;
            const previous = attempt(row);
            const payload = { ...previous.data, ...(input.signature === undefined ? {} : { signature: input.signature }), ...(input.messageText === undefined ? {} : { message: input.messageText }), ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }), ...(input.correlation === undefined ? {} : { correlation: input.correlation }) };
            return settleAttempt(attemptRows(input.seat, index, row.kind as ChannelDeliveryEvidence['kind'], previous),
                { token: input.claimToken, outcome: input.outcome, at: input.at, data: payload });
        },
        observeNativeDelivery(input: { readonly seat: EndpointRef; readonly claimToken: string; readonly observation: NonNullable<ChannelDeliveryEvidence['nativeObservations']>[number] }): boolean {
            const row = one('SELECT * FROM delivery_evidence WHERE participant_key_json=? AND generation_json=? AND claim_token_json=?', [key(input.seat.participant), encode(input.seat.generation), encode(input.claimToken)]);
            if (row === undefined || !['dispatching', 'accepted', 'unknown'].includes(string(row.outcome))) return false;
            const observation = input.observation;
            requireFact(typeof observation.eventId === 'string' && observation.eventId.length > 0);
            requireFact(typeof observation.messageId === 'string' && observation.messageId.length > 0);
            requireFact(observation.state === 'held' || observation.state === 'released' || observation.state === 'dropped');
            finite(observation.observedAt);
            if (observation.reason !== undefined) string(observation.reason);
            const payload = object(json(row.payload_json));
            const observations = payload.nativeObservations === undefined ? [] : payload.nativeObservations;
            requireFact(Array.isArray(observations));
            if (observations.some((item) => object(item).eventId === observation.eventId)) return true;
            const next = [...observations, observation];
            const count = run('UPDATE delivery_evidence SET payload_json=? WHERE participant_key_json=? AND generation_json=? AND claim_token_json=?', [encode({ ...payload, nativeObservations: next }), key(input.seat.participant), encode(input.seat.generation), encode(input.claimToken)]);
            if (count) deliveryChanged = true;
            return count > 0;
        },
    };
    Object.assign(channel, delivery);

    return Object.defineProperties(channel, { changed: { get: () => changed }, deliveryChanged: { get: () => deliveryChanged } }) as ChannelWrite & { readonly changed: boolean; readonly deliveryChanged: boolean };
}
