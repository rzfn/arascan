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
const eventProcessorClass: any = {
    'system': {
        'NewAccount': async (ctx: Context, block: Block, event: any) => {
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
    }
};

const eventPostProcess: any = {
    'system__NewAccount__timestamp__set': async (ctx: Context, _block: Block, event: any, d: any) => {
        const accountId = event.data[0].toHuman();
        ctx.db.collection('accounts').updateOne({ '_id': accountId },
            { '$set': { 'created_ts': d.updater_extr.method.args[0].toNumber() } })
    },
    'balances__Transfer__*': async (ctx: Context, _block: Block, event: any, _d: any) => {
        const accountId1 = event.data[0].toHuman();;
        const accountId2 = event.data[1].toHuman();;
        updateAccount(ctx, accountId1);
        updateAccount(ctx, accountId2);
    }
};

function toHex(d: any) {
    return Buffer.from(d).toString("hex");
}

function toNumber(d: any) {
    return parseInt(d) || 0;
}

async function updateAccount(ctx: Context, accountId: string) {
    const bal = await ctx.api.query.system.account(accountId);
    ctx.db.collection('accounts').updateOne({ '_id': accountId },
        { '$set': { 'balance': bal.data.toJSON() } },
        { upsert: true });
}

async function updateStats(ctx: Context) {
    let { api, db } = ctx;

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

async function processBlock(ctx: Context, blockHash: Hash, verbose: boolean = false, callback: (skipped: boolean) => void = () => { }) {
    const { api, db } = ctx;

    let signedBlock = await api.rpc.chain.getBlock(blockHash);
    let { block: { header: { parentHash, number, hash }, extrinsics } } = signedBlock;
    const block = signedBlock.block;
    const blockNumber = number.toNumber();

    if (verbose) {
        process.stdout.write(`[${number}] ${hash.toHex()}\r`);
    }

    // process events
    const allEvents = await api.query.system.events.at(hash);

    const colTrf = db.collection('transfers');
    const colExtr = db.collection('blocks');
    const colEvents = db.collection('events');

    // check is already exists
    const exists = await colExtr.findOne({ '_id': blockNumber });

    if (exists != null) {
        console.log(`\nBlock [${blockNumber}] exists, ignored.`);
        callback(true);
        return;
    }

    // console.log(`${allEvents}`);

    let procExtrs =
        await Promise.all(extrinsics.map(async (extr, index) => {

            let { signer, method: { callIndex, args } } = extr;

            allEvents
                .filter(({ phase, event }) =>
                    phase.isApplyExtrinsic &&
                    phase.asApplyExtrinsic.eq(index) &&
                    event.method != 'ExtrinsicSuccess'
                ).forEach(({ event }) => {
                    const dataJson = event.data.toJSON();
                    const dataHash = crc32(dataJson);
                    colEvents.updateOne({
                        'block': blockNumber, 'extrinsic_index': index,
                        'section': event.section, 'method': event.method,
                        'data_hash': dataHash
                    }, {
                        '$set': {
                            'block': blockNumber,
                            'extrinsic_index': index,
                            'section': event.section,
                            'method': event.method,
                            'data': dataJson,
                        }
                    }, { upsert: true });
                    if (eventProcessorClass[event.section] && eventProcessorClass[event.section][event.method]) {
                        eventProcessorClass[event.section][event.method](ctx, block, event);
                    }
                });

            let method = "unknown";
            let section = "unknown";


            // let { method, section } = api.registry.findMetaCall(callIndex);

            try {
                const mCall = api.registry.findMetaCall(callIndex);
                if (mCall != null){
                    method = mCall.method;
                    section = mCall.section;
                }
            } catch (e) {
                console.log(`[ERROR] ${e}`);
            }
            section = section.toString();

            if (metaClassMap[`${section}`] && metaClassMap[`${section}`][`${method}`] == "transfer") {
                console.log(`\n${extr}`);

                if (metaClassMap[`${section}`][`${method}`] == "transfer") {
                    console.log(`[${blockNumber}] ${section}/${method}: ${signer} -> ${args[0]} amount: ${args[1]}`);
                }

                let query = {
                    'block': blockNumber,
                    'src': `${signer}`,
                    'dst': `${args[0]}`,
                    'nonce': extr.nonce.toNumber()
                };

                await colTrf.updateOne(
                    query,
                    {
                        '$set':
                        {
                            'block': blockNumber,
                            'src': `${signer}`,
                            'dst': `${args[0]}`,
                            'amount': `${args[1]}`
                        }
                    }, { upsert: true });

                let obj = await colTrf.findOne(query);
                return [{ trait: "target", section, method, id: obj._id, nonce: extr.nonce.toNumber() }];
            } else if (section == "timestamp") {
                return [{ trait: "updater", section, method, extr }];
            } else if (section != "authorship") {
                console.log(`[${blockNumber}] ${section} ${extr}`);
            }
            return [];
        }));

    let [updater, targets] = _.partition(_.flatMap(procExtrs, (a: any) => a), (d: any) => d.trait == "updater");

    if (updater.length > 0) {
        targets.forEach((d: any) => {
            let { section, method } = d;
            method = metaClassMap[section][method];
            d.updater_extr = updater[0].extr;
            if (processorClass[`${updater[0].section}`] && processorClass[`${updater[0].section}`][`${updater[0].method}__${method}`]) {
                processorClass[`${updater[0].section}`][`${updater[0].method}__${method}`](ctx, d);
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

    // finally add the block into the db
    await colExtr.updateOne({ '_id': blockNumber }, {
        '$set': {
            'block_num': blockNumber,
            'block_hash': hash.toHex(),
            'block_parent_hash': parentHash.toHex(),
            'extrinsics': JSON.parse(`${extrinsics}`)
        }
    }, { 'upsert': true });


    callback(false);
}


async function getLastBlock(db: Db) {
    return await db.collection("processed").findOne({ '_id': 'last_block' });
}

import { isHex, isU8a, u8aToHex } from "@polkadot/util";
import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";

export {
    processBlock, updateAccount,
    toHex, toNumber, getLastBlock, Context,
    isHex, isU8a, u8aToHex, decodeAddress, encodeAddress,
    updateStats
};
