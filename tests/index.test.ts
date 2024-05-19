import { describe, expect, it } from "@jest/globals";
import {
  PrivateKey,
  setNumberOfWorkers,
  Mina,
  VerificationKey,
  UInt64,
  PublicKey,
  fetchAccount,
} from "o1js";
import { RollupContract } from "../src/contract/domain-contract";
import { getValidators } from "../src/rollup/validators-proof";
import { nameContract } from "../src/config";
import { zkCloudWorkerClient, blockchain, initBlockchain } from "zkcloudworker";
import { DomainDatabase } from "../src/rollup/database";
import { zkcloudworker } from ".."; //, setVerificationKey
import { loadFromIPFS } from "../src/contract/storage";
import packageJson from "../package.json";
import { algoliaWriteBlock } from "../src/nft";
const { name: repo, author: developer, version } = packageJson;

setNumberOfWorkers(8);
const chain: blockchain = "zeko" as blockchain;
const deploy = true;
const useLocalCloudWorker = true;
const api = new zkCloudWorkerClient({
  jwt: "local",
  zkcloudworker,
  chain,
});

const contractPrivateKey = nameContract.contractPrivateKey;
const contractPublicKey = contractPrivateKey.toPublicKey();

describe("Domain Name Service Contract", () => {
  it(`should initialize blockchain`, async () => {
    nameContract.contractPrivateKey = contractPrivateKey;
    nameContract.contractAddress = contractPublicKey.toBase58();
    if (chain === "local" || chain === "lightnet") {
      await initBlockchain(chain);
    } else {
      console.log("non-local chain:", chain);
      await initBlockchain(chain);
    }
    console.log("blockchain initialized:", chain);
    console.log("contract address:", contractPublicKey.toBase58());
  });

  it(`should index NFTs`, async () => {
    const blocks = await getBlocks();
    expect(blocks).toBeDefined();
    if (blocks === undefined) throw new Error("Blocks not found");
    // sort blocks by block number
    blocks.sort((a: any, b: any) => a.blockNumber - b.blockNumber);
    for (const block of blocks) {
      const txs = await getTransactions(block.ipfs);
      console.log(`Block ${block.blockNumber} transactions:`, txs?.length);
      await algoliaWriteBlock({
        contractAddress: contractPublicKey.toBase58(),
        chain,
        block,
        txs,
      });
    }
  });
});

async function getBlocks() {
  const blocks = await api.execute({
    repo,
    task: "getBlocksInfo",
    transactions: [],
    args: JSON.stringify({
      contractAddress: contractPublicKey.toBase58(),
      allBlocks: true,
    }),
    developer,
    metadata: `get blocks`,
    mode: "sync",
  });
  expect(blocks).toBeDefined();
  //console.log(`info api call result:`, blocks);
  expect(blocks.success).toBe(true);
  expect(blocks.result).toBeDefined();
  let data = JSON.parse(blocks.result);
  return data?.blocks;
}

async function getTransactions(ipfs: string) {
  expect(ipfs).toBeDefined();
  if (ipfs === undefined) throw new Error("IPFS hash not defined");
  const blockData = await loadFromIPFS(ipfs);
  return blockData.transactions.map((tx: any) => tx.tx);
  /*
  const databaseIPFS = blockData.database;
  expect(databaseIPFS).toBeDefined();
  const databaseJson = await loadFromIPFS(databaseIPFS.slice(2));
  expect(databaseJson).toBeDefined();
  expect(databaseJson.database).toBeDefined();
  database = new DomainDatabase(databaseJson.database);
  const storages: Storage[] = [];
  Object.keys(database.data).forEach((name) => {
    console.log(`Name: ${name}, Record: ${database.data[name]}`);
    const domainName = RollupNftName.fromFields(
      deserializeFields(database.data[name])
    );
    storages.push(
      new Storage({
        hashString: [
          domainName.data.storage.hashString[0],
          domainName.data.storage.hashString[1],
        ],
      })
    );
  });
  for (const storage of storages) {
    const nft = new RollupNFT({ storage });
    await nft.loadMetadata();
    console.log("Rollup NFT", nft.name);
    console.log("url:", nft.getURL());
    console.log(
      "uri:",
      "https://gateway.pinata.cloud/ipfs/" + nft.storage?.toIpfsHash()
    );
  }
  */
}

async function accountBalance(address: PublicKey): Promise<UInt64> {
  try {
    await fetchAccount({ publicKey: address });
    if (Mina.hasAccount(address)) return Mina.getBalance(address);
    else return UInt64.from(0);
  } catch (error: any) {
    console.log("fetchAccount error: ", error);
    return UInt64.from(0);
  }
}

async function accountBalanceMina(address: PublicKey): Promise<number> {
  return Number((await accountBalance(address)).toBigInt()) / 1e9;
}
