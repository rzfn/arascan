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
import { hexToString } from '@polkadot/util';

require('dotenv').config();


async function main() {
    console.log("Block inspector");

    const api = await ApiPromise.create({
        types: {
            Address: 'MultiAddress',
            LookupSource: 'MultiAddress'
        }
    });

    const blockNum = process.argv.find((a) => a.startsWith('--num='))?.split('=')[1];
    if (!blockNum){
        console.log("No block num, please set --num parameter");
        return;
    }

    const hash = await api.rpc.chain.getBlockHash(blockNum);
    const block = await api.rpc.chain.getBlock(hash);

    block.block.extrinsics.forEach((extr)=>{
        const callMeta = api.registry.findMetaCall(extr.method.callIndex);
        console.log(`${callMeta.section}.${callMeta.method}`);
        console.log(extr.method.method)
        if (extr.method.method === "setIdentity"){
            console.log(extr.args.map((a:any) => hexToString(a.display.asRaw.toHex()) ))
        }
    });
}


main().catch(console.error);
