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

import { ApiPromise } from '@polkadot/api';
import type { Hash } from '@polkadot/types/interfaces';
import { MongoClient } from 'mongodb';
import { Context, getLastBlock, processBlock } from '@arascan/components';

require('dotenv').config();

class Counter {
    proceed: number;
    skipped: number;
    constructor(proceed: number) {
        this.proceed = proceed;
        this.skipped = 0;
    }

    incProceed() {
        this.proceed++;
        return this;
    }

    incSkipped() {
        this.skipped++;
        return this;
    }
}

const MAX_SKIP_BLOCKS = 50;
const noSkipLimit = process.argv.indexOf('--no-skip-limit') > -1;

async function startSequencing(ctx: Context, blockHash: Hash, untilBlockNum: number, counter: Counter, done: () => void) {
    const { api } = ctx;

    let block = await api.rpc.chain.getBlock(blockHash);
    let { block: { header: { parentHash, number, hash } } } = block;
    const blockNumber = number.toNumber();

    await processBlock(ctx, hash, true, (skipped) => {
        if (skipped) {
            counter.incSkipped();
        } else {
            counter.incProceed();
        }
        if ((blockNumber > 2 && blockNumber > untilBlockNum) && counter.skipped > MAX_SKIP_BLOCKS
            || noSkipLimit) {
            setTimeout(async () => await startSequencing(ctx, parentHash,
                untilBlockNum, counter, done), 10);
        } else {
            if (counter.skipped >= MAX_SKIP_BLOCKS) {
                console.log(`Sequencing stoped by max skip blocks ${MAX_SKIP_BLOCKS}, total ${counter.proceed} proceed.`);
            } else {
                console.log(`Sequencing finished, ${counter.proceed} proceed, ${counter.skipped} skipped.`);
            }
            done();
        }
    });
}

async function main() {
    console.log("STARTING SEQUENCER...");

    const dbUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';

    const api = await ApiPromise.create({
        types: {
            Address: 'MultiAddress',
            LookupSource: 'MultiAddress'
        }
    });

    console.log(`${process.argv}`)
    const seqAll = process.argv.indexOf('--all') > -1;

    let startingBlockNumber = process.argv.find(a => a.startsWith("--starting-block="));

    let startingBlockHash = (await api.rpc.chain.getBlockHash());
    let startingBlock: any = null;

    if (startingBlockNumber) {
        startingBlockNumber = startingBlockNumber.split("=")[1];
        startingBlockHash = (await api.rpc.chain.getBlockHash(startingBlockNumber));
        console.log(`Use user specified starting block [${startingBlockNumber}] ${startingBlockHash}`);
    }
    startingBlock = (await api.rpc.chain.getHeader(startingBlockHash));

    MongoClient.connect(dbUri, async (err, client: MongoClient) => {
        if (err == null) {
            const db = client.db("nuchain");

            let untilBlock = 0;
            if (!seqAll) {
                const lastProcBlock = (await getLastBlock(db))?.value;
                if (lastProcBlock != null) {
                    console.log(`starting block [${startingBlock.number}] until block: [${lastProcBlock.number}] ${lastProcBlock.hash}`);
                    untilBlock = lastProcBlock.number;
                }
            }

            let ctx = new Context(api, db, client);

            // await processBlock(ctx, header.hash, untilBlockHash);
            let counter = new Counter(0);

            await startSequencing(ctx, startingBlock.hash, untilBlock, counter, () => {

                console.log("Setting last processed block");

                let data = startingBlock.toJSON();
                data['hash'] = startingBlockHash.toHex() as any;

                db.collection("processed").updateOne({ '_id': 'last_block' },
                    { '$set': { 'value': data } }, { 'upsert': true });

                console.log("Done.");

                client.close();
                process.exit(0);
            });


            process.on('SIGINT', (_code) => {
                console.log("quiting...");
                client.close();
                process.exit(0);
            });

        }
    });
}


main().catch(console.error);
