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


import { MongoClient, Db } from "mongodb";
import { isHex, toNumber } from "@arascan/components";
import { ApiPromise, WsProvider } from "@polkadot/api";

const restify = require('restify');

require('dotenv').config();

const dbUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';

function withDb<T>(callback: (db: Db, client: MongoClient) => Promise<T>) {
    let afterCompleted = (() => ({}));
    const doner = {
        done(whenDone: () => T) {
            afterCompleted = whenDone;
        }
    };
    MongoClient.connect(dbUri, {poolSize: 10}, async (err: any, client: MongoClient) => {
        if (err != null) {
            console.log(`[ERROR] cannot get db: ${err}`);
            afterCompleted();
            return;
        }
        try {
            await callback(client.db("nuchain"), client);
        } catch (error) {
            console.log(`[ERROR] ${error}`);
        } finally {
            client.close();
            afterCompleted();
        }
    });
    return doner;
}

// function getTransfers(req: any, res: any, next: any) {
//     const addr = req.params.addr;
//     const { skip, limit } = parseSkipLimit(req);

//     withDb(async (db, _client) => {
//         db.collection("transfers").find({
//             '$or': [
//                 { 'src': addr },
//                 { 'dst': addr }
//             ]
//         })
//         .sort({ 'ts': -1 })
//         .skip(skip).limit(limit)
//         .toArray((err: any, result: Array<any>) => {
//             if (err == null) {
//                 res.send({ entries: result });
//             }
//         });
//     }).done(next);

// }

function getAccounts(req: any, res: any, next: any) {
    const { skip, limit } = parseSkipLimit(req);

    if (!validOffsetLimit(skip, limit)) {
        res.send({ entries: [] });
        return next();
    }

    withDb((db, _client) => {
        db.collection("accounts")
            .find({})
            .sort({ 'created_ts': -1 })
            .skip(skip).limit(limit)
            .toArray((err: any, result: Array<any>) => {
                if (err == null) {
                    res.send({ entries: result.filter((a) => a.created_ts != null && a.created_ts > 0) });
                }
            });
        return Promise.resolve();
    }).done(next);
}

function parseSkipLimit(req: any) {
    const skip = parseInt(req.query.skip || '0');
    const limit = parseInt(req.query.limit || '50');
    return { skip, limit }
}

function getAccountTransfers(req: any, res: any, next: any) {
    const addr = req.params.addr;
    const { skip, limit } = parseSkipLimit(req);
    if (!validOffsetLimit(skip, limit)) {
        res.send({ entries: [] });
        return next();
    }

    withDb(async (db, _client) => {
        const count = await db.collection("transfers")
            .count({ '$or': [{ 'src': addr }, { 'dst': addr }] });
        if (count > 0) {
            db.collection("transfers")
                .find({ '$or': [{ 'src': addr }, { 'dst': addr }] })
                .sort({ 'ts': -1 })
                .skip(skip).limit(limit)
                .toArray((err: any, result: Array<any>) => {
                    if (err == null) {
                        res.send({ entries: result, count });
                    }
                });
        } else {
            res.send({ entries: [], count });
        }

    }).done(next);
}

function getAccountOne(req: any, res: any, next: any) {
    const addr = req.params.addr;

    withDb((db, _client) => {
        return db.collection("accounts")
            .findOne({ '_id': addr })
            .then((result) => {
                res.send({ result });
            });
    }).done(next);
}

function validOffsetLimit(offset: number, limit: number): boolean {
    return offset > -1 && offset < 100000 && limit > -1 && limit < 1000;
}


function getBlockOne(req: any, res: any, next: any) {
    let blockNumOrHash = req.params.block;
    blockNumOrHash = isHex(blockNumOrHash) ? blockNumOrHash : toNumber(blockNumOrHash);
    if (blockNumOrHash.length > 500) {
        res.send({ result: null });
        next();
        return;
    }
    withDb((db, _client) => {
        return db.collection("blocks")
            .findOne({ $or: [{ '_id': blockNumOrHash }, { 'block_hash': blockNumOrHash }] })
            .then((result: any) => {
                res.send({ result });
            });
    }).done(next);
}


function getBlocks(req: any, res: any, next: any) {
    const skip = parseInt(req.query.skip || '0');
    const limit = parseInt(req.query.limit || '50');
    if (!validOffsetLimit(skip, limit)) {
        res.send({ entries: [] });
        return next();
    }

    withDb((db, _client) => {
        db.collection("blocks")
            .find({})
            .sort({ '_id': -1 })
            .skip(skip).limit(limit)
            .toArray((err: any, result: Array<any>) => {
                if (err == null) {
                    res.send({ entries: result });
                }
            });
        return Promise.resolve();
    }).done(next);
}


function getEvents(req: any, res: any, next: any) {
    const skip = parseInt(req.query.skip || '0');
    const limit = parseInt(req.query.limit || '50');
    if (!validOffsetLimit(skip, limit)) {
        res.send({ entries: [] });
        return next();
    }

    withDb((db, _client) => {
        db.collection("events")
            .find({})
            .sort({ 'block': -1 })
            .skip(skip).limit(limit)
            .toArray((err: any, result: Array<any>) => {
                if (err == null) {
                    res.send({ entries: result });
                }
            });
        return Promise.resolve();
    }).done(next);
}

async function queryStats(db: any) {
    const accountCount = await db.collection("accounts").countDocuments({});
    const eventCount = await db.collection("events").countDocuments({});
    const { era, finalizedBlockCount, session, validators } = await db.collection("metadata").findOne({ '_id': "stats" });
    return {
        accounts: accountCount,
        events: eventCount,
        era,
        finalized_block: finalizedBlockCount,
        session,
        validators
    };
}

function getStats(_req: any, res: any, next: any) {
    withDb((db, _client) => {
        return queryStats(db).then((stats) => {
            res.send({ result: stats });
        }).catch((_err) => res.send({ result: {"error": "Cannot get stats data from database"} }));
    }).done(next);
}

function getToken(_req: any, res: any, next: any) {
    withDb(async (db, _client) => {
        // @TODO: temporary, please change with data from market when ready

        let tokens = await db.collection("tokens").find().toArray();
        tokens = tokens.sort((a:any, _b:any) => a["_id"] == "ARA" ? -1 : 0);
        const tokenSymbols = tokens.map(({_id, price, asset_id}) => [_id, price, asset_id]);

        const detail = {};

        tokenSymbols.forEach(tok => {
            detail[tok[0]] = {
                'asset_id': tok[2] || 0,
                'price': tok[1]
            }
        });

        res.send({
            'data': {
                token: tokenSymbols.map(a => a[0]),
                detail: detail
            }
        });
    }).done(next);
}


const WebSocket = require("ws");

const server = restify.createServer();

const wss = new WebSocket.Server({ server: server.server });

server.use(restify.plugins.queryParser());


server.use(
    function crossOrigin(_req: any, res: any, next: any) {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Headers", "X-Requested-With");
        return next();
    }
);

function wsSend(ws: WebSocket, data: any) {
    try {
        ws.send(JSON.stringify(data));
    } catch (error) {
        console.log(error);
    }
}

const WS_CLIENTS: any = [];
wss.on('connection', function connection(ws: any) {

    WS_CLIENTS.push(ws);

    console.log("got ws connection");
    ws.on('message', function incoming(message: any) {
        console.log('received: %s', message);
    });
    wsSend(ws, {
        type: "connected"
    });

    ws.on("close", () => {
        console.log("ws client closed");
        WS_CLIENTS.splice(WS_CLIENTS.indexOf(ws), 1);
    });

    ws.on('error', () => {
        console.log("WS ERROR");
        WS_CLIENTS.splice(WS_CLIENTS.indexOf(ws), 1);
        console.log(WS_CLIENTS)
    });
});

const WS_SOCKET_URL = process.env.NUCHAIN_WS_SOCKET_URL || 'ws://127.0.0.1:9944'

console.log(`Using WS socket address: ${WS_SOCKET_URL}`);

ApiPromise.create({
    provider: new WsProvider(WS_SOCKET_URL),
    types: {
        Address: 'MultiAddress',
        LookupSource: 'MultiAddress'
    }
}).then((api) => {

    api.rpc.chain.subscribeNewHeads(async (head: any) => {
        const blockHash = await api.rpc.chain.getBlockHash(head.number);

        WS_CLIENTS.forEach((ws: any) => {
            wsSend(ws, {
                type: 'new_block',
                data: {
                    'number': head.number.toNumber(),
                    'hash': blockHash,
                }
            });

            withDb(async (db, _client) => {
                wsSend(ws, {
                    type: "stats",
                    data: await queryStats(db)
                });
            });
        });

    })

});


// server.get('/transfers/:addr', getTransfers);
server.get('/account/:addr/transfers', getAccountTransfers);
server.get('/account/:addr', getAccountOne);
server.get('/accounts', getAccounts);
server.get('/block/:block', getBlockOne);
server.get('/blocks', getBlocks);
server.get('/events', getEvents);
server.get('/stats', getStats);
server.get('/token', getToken);

const listenAll = process.argv.indexOf('--listen-all') > -1;

server.listen('8089', listenAll ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(`${server.name} listening at ${server.url}`);
});

