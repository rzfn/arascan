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
import { Context, updateAccount } from '@arascan/components';

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


async function main() {
    console.log("Starting Account Updater...");

    const dbUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';

    const api = await ApiPromise.create({
        types: {
            Address: 'MultiAddress',
            LookupSource: 'MultiAddress'
        }
    });

    MongoClient.connect(dbUri, async (err, client: MongoClient) => {
        if (err == null) {
            const db = client.db("nuchain");

            const ctx = new Context(api, db, client);

            const counter = new Counter(0);
            const doner = new Promise((resolve:any)=>{
                db.collection("accounts").find({})
                .toArray(async (err: any, result: Array<any>) => {
                    if (err == null) {
                        result.forEach(async (acc) => {
                            console.log("processing: ", acc._id)
                            counter.incProceed();
                            updateAccount(ctx, acc._id);
                        })
                    }
                    resolve();
                });
            })

            await doner;

            console.log(`Done. ${counter.proceed} proceed.`);

            // process.on('SIGINT', (_code) => {
                // console.log("quiting...");
                client.close();
                process.exit(0);
            // });

        }
    });
}


main().catch(console.error);
