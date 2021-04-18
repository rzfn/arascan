// Copyright 2021 Rantai Nusantara Foundation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type { ApiPromise } from '@polkadot/api';
import { hexToString, isHex, isU8a, u8aToHex } from "@polkadot/util";
import type { Block, Hash } from '@polkadot/types/interfaces';

import type { MongoClient, Db } from 'mongodb';

const _ = require('lodash');
const crc32 = require('crc32');

class Context {
    api!: ApiPromise
    db!: Db
    client!: MongoClient

    constructor(api: ApiPromise, db: Db, client: MongoClient) {
        this.db = db;
        this.client = client;
        this.api = api;
    }
}

const metaClassMap: any = {
    'balances':
    {
        'forceTransfer': 'transfer',
        'transferKeepAlive': 'transfer',
        'transfer': 'transfer'
    },
    "timestamp": {
        'set': 'set'
    }
};

const processorClass: any = {
    'timestamp': {
        'set__transfer': (ctx: Context, d: any) => {
            ctx.db.collection('transfers').updateOne({ '_id': d.id }, {
                '$set': { 'ts': d.updater_extr.method.args[0].toNumber(), 'nonce': d.nonce },
            })
        }
    }
};

const systemEventProcessorClass: any = {
    'NewAccount': async (ctx: Context, event: any, _eventIdx: number, block: Block, _blockTs: number, _extrIdx: number) => {
        const accountId = event.data[0].toHuman();
        const bal = await ctx.api.query.system.account(accountId);
        ctx.db.collection('accounts').updateOne({ '_id': accountId },
            {
                '$set': {
                    'balance': bal.data.toJSON(),
                    'created_at_block': block.header.number.toNumber()
                }
            },
            { upsert: true })
    }
};

function processStakingEvent(ctx: Context, method: string, event: any, eventIdx: number, block: Block, blockTs: number, extrIdx: number) {
    if (['Bonded', 'Reward', 'Slash', 'Unbounded', 'Withdrawn'].indexOf(method) >= 0) {
        const blockNumber = block.header.number.toNumber();

        // Note(exa): not sure which one is the correct one
        const eventIndex = `${blockNumber}-${extrIdx}`;
        const extrIndex = `${blockNumber}-${extrIdx}`;

        ctx.db.collection('staking_txs').updateOne(
            {
                'stash_id': event.data[0].toHuman(),
                'block_num': block.header.number.toNumber(),
                'extrinsic_idx': extrIdx,
                'event_idx': eventIdx,
            },
            {
                '$set': {
                    'block_timestamp': blockTs,
                    'amount': `${event.data[1]}`,
                    'event_id': method,
                    'event_index': eventIndex,
                    'extrinsic_index': extrIndex,
                }
            },
            { upsert: true });
    }
}

const eventProcessorClass: any = {
    'system': async (ctx: Context, method: string, event: any, eventIdx: number, block: Block, blockTs: number, extrIdx: number) => {
        systemEventProcessorClass[method](ctx, event, eventIdx, block, blockTs, extrIdx)
    },
    'staking': processStakingEvent,
};

const eventPostProcess: any = {
    'system__NewAccount__timestamp__set': (ctx: Context, _block: Block, event: any, d: any) => {
        const accountId = event.data[0].toHuman();
        ctx.db.collection('accounts').updateOne({ '_id': accountId },
            { '$set': { 'created_ts': d.updater_extr.method.args[0].toNumber() } })
    },
    'balances__Transfer__*': async (ctx: Context, _block: Block, event: any, _d: any) => {
        const accountId1 = event.data[0].toHuman();
        const accountId2 = event.data[1].toHuman();
        await updateAccount(ctx, accountId1);
        await updateAccount(ctx, accountId2);
    },
    'identity__IdentitySet__*': async (ctx: Context, _block: Block, event: any, _d: any) => {
        const accountId = event.data[0].toHuman();
        await updateAccount(ctx, accountId, new UpdateOptions().setIdentity(true));
    }
};

function toHex(d: any) {
    return Buffer.from(d).toString("hex");
}

function toNumber(d: any) {
    return parseInt(d) || 0;
}

class UpdateOptions {
    identity: boolean;

    constructor(identity: boolean = false) {
        this.identity = identity;
    }

    static default(): UpdateOptions {
        return new UpdateOptions();
    }

    setIdentity(identity: boolean) {
        this.identity = identity;
        return this;
    }
}

async function updateAccount(ctx: Context, accountId: string, opts: UpdateOptions = UpdateOptions.default()) {
    const bal = await ctx.api.query.system.account(accountId);
    await ctx.db.collection('accounts').updateOne({ '_id': accountId },
        { '$set': { 'balance': bal.data.toJSON() } },
        { 'upsert': true });

    // update identity
    if (opts.identity) {
        const rv = await ctx.api.query.identity.identityOf(accountId);
        if (rv.isSome) {
            const identity = rv.unwrap();
            const ident: any = {};
            if (identity.info.display.isRaw) {
                ident['display'] = hexToString(identity.info.display.asRaw.toHex());
            }
            if (identity.info.legal.isRaw) {
                ident['legal'] = hexToString(identity.info.legal.asRaw.toHex());
            }
            if (identity.info.web.isRaw) {
                ident['web'] = hexToString(identity.info.web.asRaw.toHex());
            }
            if (identity.info.email.isRaw) {
                ident['email'] = hexToString(identity.info.email.asRaw.toHex());
            }
            if (identity.info.twitter.isRaw) {
                ident['twitter'] = hexToString(identity.info.twitter.asRaw.toHex());
            }
            if (identity.info.image.isRaw) {
                ident['image'] = hexToString(identity.info.image.asRaw.toHex());
            }
            await ctx.db.collection("accounts").updateOne({ '_id': accountId },
                { '$set': { 'identity': ident } }, { 'upsert': true });
        }
    }

}

async function updateStats(ctx: Context) {
    const { api, db } = ctx;

    const era = (await api.query.staking.currentEra()).unwrap().toNumber();
    const session = (await api.query.session.currentIndex()).toNumber();
    const validators = (await api.query.session.validators()).map((a) => a.toHuman());
    const finalizedBlockHead = (await api.rpc.chain.getFinalizedHead()
        .then((blockHash) => api.rpc.chain.getBlock(blockHash)));
    const finalizedBlockCount = finalizedBlockHead.block.header
        .number.toNumber();

    db.collection("metadata").updateOne({ '_id': 'stats' }, {
        '$set': {
            era, session, validators,
            finalizedBlockCount
        }
    }, { upsert: true });

}

async function processBlock(ctx: Context, blockHash: Hash, verbose = false, callback: (skipped: boolean) => void = () => ({})) {
    const { api, db } = ctx;

    const signedBlock = await api.rpc.chain.getBlock(blockHash);
    const { block: { header: { parentHash, number, hash }, extrinsics } } = signedBlock;
    const block = signedBlock.block;
    const blockNumber = number.toNumber();

    if (verbose) {
        process.stdout.write(`[${number}] ${hash.toHex()}\r`);
    }

    let blockTs: any;
    block.extrinsics.forEach((extr) => {
        let method = "unknown";
        let section = "unknown";

        try {
            const mCall = ctx.api.registry.findMetaCall(extr.callIndex);
            if (mCall != null) {
                method = mCall.method;
                section = mCall.section;
            }
        } catch (e) {
            console.log(`[ERROR] ${e}`);
        }
        section = section.toString();

        if (section == "timestamp") {
            if (method == "set") {
                blockTs = extr.method.args[0];
            }
        }
    });


    // process events
    const allEvents = await api.query.system.events.at(hash);

    const colTrf = db.collection('transfers');
    const colBlocks = db.collection('blocks');
    const colEvents = db.collection('events');

    // check is already exists
    const exists = await colBlocks.findOne({ '_id': blockNumber });

    if (exists != null) {
        console.log(`\nBlock [${blockNumber}] exists, ignored.`);
        callback(true);
        return;
    }

    // console.log(`${allEvents}`);

    const procExtrs =
        await Promise.all(extrinsics.map(async (extr, extrIdx) => {

            const { signer, method: { callIndex, args } } = extr;

            const extrIndex = `${blockNumber}-${extrIdx}`;

            allEvents
                .filter(({ phase, event }) =>
                    phase.isApplyExtrinsic &&
                    phase.asApplyExtrinsic.eq(extrIdx) &&
                    event.method != 'ExtrinsicSuccess'
                ).forEach(({ event }, eventIdx) => {
                    const dataJson = event.data.toJSON();
                    const dataHash = crc32(dataJson);
                    colEvents.updateOne({
                        'block': blockNumber, 'extrinsic_index': extrIdx,
                        'section': event.section, 'method': event.method,
                        'data_hash': dataHash
                    }, {
                        '$set': {
                            'block': blockNumber,
                            'extrinsic_index': extrIdx,
                            'section': event.section,
                            'method': event.method,
                            'data': dataJson,
                        }
                    }, { upsert: true });
                    eventProcessorClass[event.section]?.(
                        ctx, event.method, event, eventIdx,
                        block, blockTs?.toNumber(), extrIdx);
                });

            let method = "unknown";
            let section = "unknown";

            try {
                const mCall = api.registry.findMetaCall(callIndex);
                if (mCall != null) {
                    method = mCall.method;
                    section = mCall.section;
                }
            } catch (e) {
                console.log(`[ERROR] ${e}`);
            }
            section = section.toString();

            if (metaClassMap[`${section}`] && metaClassMap[`${section}`][`${method}`] == "transfer") {
                console.log(`\n${extr}`);
                console.log(`[${blockNumber}] ${section}/${method}: ${signer} -> ${args[0]} amount: ${args[1]}`);

                const query = {
                    'src': `${signer}`,
                    'nonce': extr.nonce.toNumber(),
                };

                let result = await colTrf.updateOne(
                    query,
                    {
                        '$set':
                        {
                            'src': `${signer}`,
                            'nonce': extr.nonce.toNumber(),
                            'block': blockNumber,
                            'extrinsic_index': extrIndex,
                            'dst': `${args[0]}`,
                            'amount': `${args[1]}`,
                        }
                    }, { upsert: true });

                // If nothing has changed, don't do further processing.
                if (result.upsertedCount == 0 && result.modifiedCount == 0) {
                    return [];
                }

                const obj = await colTrf.findOne(query);
                return [{ trait: "target", section, method, id: obj._id, nonce: extr.nonce.toNumber() }];
            } else if (section == "identity") {
                return [{ trait: "target", section, method, extr }];
            } else if (section == "timestamp") {
                return [{ trait: "updater", section, method, extr }];
            } else if (section != "authorship") {
                console.log(`[${blockNumber}] ${section} ${extr}`);
            }
            return [];
        }));

    const [updater, targets] = _.partition(_.flatMap(procExtrs, (a: any) => a), (d: any) => d.trait == "updater");

    if (updater.length > 0) {
        targets.forEach((d: any) => {
            const { section, method } = d;
            if (metaClassMap[section] != null) {
                const _method = metaClassMap[section][method];
                d.updater_extr = updater[0].extr;
                if (processorClass[`${updater[0].section}`] && processorClass[`${updater[0].section}`][`${updater[0].method}__${_method}`]) {
                    processorClass[`${updater[0].section}`][`${updater[0].method}__${_method}`](ctx, d);
                }
            }

            allEvents.forEach(({ event }) => {
                let key = `${event.section}__${event.method}__${updater[0].section}__${updater[0].method}`;
                if (eventPostProcess[key]) {
                    eventPostProcess[key](ctx, block, event, d);
                }
                key = `${event.section}__${event.method}__*`
                if (eventPostProcess[key]) {
                    eventPostProcess[key](ctx, block, event, d);
                }
            });
        });
    }

    try {
        // finally add the block into the db
        await colBlocks.updateOne({ '_id': blockNumber }, {
            '$set': {
                'block_num': blockNumber,
                'block_hash': hash.toHex(),
                'block_parent_hash': parentHash.toHex(),
                'extrinsics': JSON.parse(`${extrinsics}`)
            }
        }, { 'upsert': true });
    } catch (error) {
        console.log(`[ERROR] updating blocks data error ${error}`)
    }


    callback(false);
}


async function getLastBlock(db: Db) {
    return await db.collection("processed").findOne({ '_id': 'last_block' });
}


import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";

export {
    processBlock, updateAccount,
    toHex, toNumber, getLastBlock, Context,
    isHex, isU8a, u8aToHex, decodeAddress, encodeAddress,
    updateStats
};
