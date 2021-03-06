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
import { MongoClient } from 'mongodb';
import { Context, processBlock, updateStats } from '@arascan/components';

require('dotenv').config();

async function main() {
    const dbUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';

    const api = await ApiPromise.create({
        types: {
            Address: 'MultiAddress',
            LookupSource: 'MultiAddress'
        }
    });

    const validators = await api.query.staking.validators.keys();

    console.log(`${validators}`);

    const unsub = await api.rpc.chain.subscribeNewHeads((header) => {
        MongoClient.connect(dbUri, async (err, client: MongoClient) => {
            if (err == null) {
                const db = client.db("nuchain");

                console.log(`Imported block #${header.number}`);

                let ctx = new Context(api, db, client);

                await processBlock(ctx, header.hash, false)
                    .then(() => updateStats(ctx))

                client.close();
            }
        });
    });

    process.on('SIGINT', (_code) => {
        console.log("quiting...");
        unsub();
    });
}

// function testBlock(){
    // // for debugging
    // MongoClient.connect(dbUri, async (err, client: MongoClient) => {
    //     if (err == null) {
    //         const db = client.db("nuchain");
    //         let ctx = new Context(api, db, client);
    //         let blockHash = (await api.rpc.chain.getBlockHash(53871));
    //         await processBlock(ctx, blockHash);
    //     }
    // });
// }


main().catch(console.error);
