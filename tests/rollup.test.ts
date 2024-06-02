import { describe, expect, it } from "@jest/globals";
import {
  Field,
  PrivateKey,
  setNumberOfWorkers,
  Mina,
  AccountUpdate,
  VerificationKey,
  UInt64,
  Cache,
  PublicKey,
  Encoding,
  verify,
  fetchAccount,
  Signature,
} from "o1js";
import { RollupNFT, Storage } from "minanft";
import {
  ValidatorsVoting,
  ValidatorsDecision,
  ValidatorDecisionType,
  ValidatorsVotingProof,
} from "../src/rollup/validators";
import {
  RollupContract,
  BlockContract,
  ChangeValidatorsData,
} from "../src/contract/domain-contract";
import { getValidators } from "../src/rollup/validators-proof";
import { nameContract, blockProducer } from "../src/config";
import {
  zkCloudWorkerClient,
  blockchain,
  sleep,
  LocalCloud,
  Memory,
  fetchMinaAccount,
  fee,
  initBlockchain,
  getNetworkIdHash,
  deserializeFields,
} from "zkcloudworker";
import {
  MapUpdate,
  DomainSerializedTransaction,
  RollupNftName,
  DomainTransaction,
} from "../src/rollup/transaction";
import { DomainDatabase } from "../src/rollup/database";
import { calculateValidatorsProof } from "../src/rollup/validators-proof";
import { zkcloudworker } from ".."; //, setVerificationKey
import { DEPLOYER, PINATA_JWT, JWT } from "../env.json";
import { uniqueNamesGenerator, names } from "unique-names-generator";
import { ImageData } from "../src/rollup/rollup-nft";
import { loadFromIPFS } from "../src/contract/storage";
import packageJson from "../package.json";
const { name: repo, author: developer, version } = packageJson;

setNumberOfWorkers(8);
const chain: blockchain = "local" as blockchain;
const deploy = true;
const update = false;
const useLocalCloudWorker = true;
const api = new zkCloudWorkerClient({
  jwt: useLocalCloudWorker ? "local" : JWT,
  zkcloudworker,
  chain,
});

let deployer: PrivateKey;
let sender: PublicKey;
const ELEMENTS_NUMBER = 1;

interface User {
  name: string;
  privateKey: PrivateKey;
  oldDomain?: string;
}

const users: User[] = [];
let database: DomainDatabase;
const addTransactions: string[] = [];
const updateTransactions: string[] = [];

const { validators, tree } = getValidators(0);

const contractPrivateKey = nameContract.contractPrivateKey;
const contractPublicKey = contractPrivateKey.toPublicKey();

const zkApp = new RollupContract(contractPublicKey);
let blockVerificationKey: VerificationKey;
let validatorsVerificationKey: VerificationKey;
let mapVerificationKey: VerificationKey;
let contractVerificationKey: VerificationKey;

describe("Domain Name Service Contract", () => {
  it(`should prepare first block data`, async () => {
    console.log("Preparing data...");
    console.time(`prepared data`);
    for (let i = 0; i < ELEMENTS_NUMBER; i++) {
      users.push({
        name: uniqueNamesGenerator({
          dictionaries: [names],
          length: 1,
        }).toLowerCase(),
        privateKey: PrivateKey.random(),
      });
    }
    for (let k = 0; k < ELEMENTS_NUMBER; k++) {
      const tx = await createAddTransaction(
        users[k].name,
        users[k].privateKey.toPublicKey().toBase58()
      );
      addTransactions.push(JSON.stringify(tx, null, 2));
    }
    console.log(
      "domainNames:",
      addTransactions.map((t) => JSON.parse(t).name)
    );

    console.timeEnd(`prepared data`);
  });
  it(`should initialize blockchain`, async () => {
    Memory.info("initializing blockchain");
    console.log("chain:", chain);
    nameContract.contractPrivateKey = contractPrivateKey;
    nameContract.contractAddress = contractPublicKey.toBase58();
    if (chain === "local" || chain === "lightnet") {
      const { keys } = await initBlockchain(chain, 2);
      expect(keys.length).toBeGreaterThanOrEqual(2);
      if (keys.length < 2) throw new Error("Invalid keys");
      deployer = keys[0].key;

      try {
        await fetchMinaAccount({ publicKey: blockProducer.publicKey });
        if (!Mina.hasAccount(blockProducer.publicKey)) {
          console.log("Block producer account not found, creating...");

          const wallet = keys[1];
          console.log("wallet:", wallet.toBase58());
          const transaction = await Mina.transaction(
            { sender: wallet, fee: "100000000", memo: "payment" },
            async () => {
              const senderUpdate = AccountUpdate.createSigned(wallet);
              senderUpdate.balance.subInPlace(1000000000);
              senderUpdate.send({
                to: blockProducer.publicKey,
                amount: 500_000_000_000,
              });
            }
          );
          transaction.sign([wallet.key]);
          await sendTx(transaction, "block producer account creation");
        }
      } catch (error: any) {
        console.error("Error in block producer account creation:", error);
        return;
      }
    } else {
      console.log("non-local chain:", chain);
      await initBlockchain(chain);
      deployer = PrivateKey.fromBase58(DEPLOYER);
    }

    process.env.DEPLOYER_PRIVATE_KEY = deployer.toBase58();
    process.env.DEPLOYER_PUBLIC_KEY = deployer.toPublicKey().toBase58();
    if (deploy) {
      expect(contractPrivateKey).toBeDefined();
      expect(contractPrivateKey.toPublicKey().toBase58()).toBe(
        contractPublicKey.toBase58()
      );
    }

    console.log("blockchain initialized:", chain);
    console.log("contract address:", contractPublicKey.toBase58());
    sender = deployer.toPublicKey();
    const networkId = Mina.getNetworkId();
    console.log("Network ID:", networkId);
    console.log("sender:", sender.toBase58());
    console.log("Sender balance:", await accountBalanceMina(sender));
    console.log(
      "Block producer balance:",
      await accountBalanceMina(blockProducer.publicKey)
    );
    expect(deployer).toBeDefined();
    expect(sender).toBeDefined();
    expect(deployer.toPublicKey().toBase58()).toBe(sender.toBase58());
    process.env.PINATA_JWT = PINATA_JWT;
    expect(process.env.PINATA_JWT).toBeDefined();
    Memory.info("blockchain initialized");
  });

  if (deploy) {
    it(`should compile contract`, async () => {
      console.log("Analyzing contract methods...");
      console.time("methods analyzed");
      //console.log("Analyzing MapUpdate methods...");
      const mapMethods = await MapUpdate.analyzeMethods();
      //console.log("Analyzing BlockContract methods...");
      const blockMethods = await BlockContract.analyzeMethods();
      //console.log("Analyzing ValidatorsVoting methods...");
      const validatorsMethods = await ValidatorsVoting.analyzeMethods();
      //console.log("Analyzing RollupContract methods...");
      const domainMethods = await RollupContract.analyzeMethods();
      const methods = [
        {
          name: "RollupContract",
          result: domainMethods,
        },
        { name: "BlockContract", result: blockMethods },
        {
          name: "ValidatorsVoting",
          result: validatorsMethods,
          skip: true,
        },
        {
          name: "MapUpdate",
          result: mapMethods,
          skip: true,
        },
      ];
      console.timeEnd("methods analyzed");
      const maxRows = 2 ** 16;
      for (const contract of methods) {
        // calculate the size of the contract - the sum or rows for each method
        const size = Object.values(contract.result).reduce(
          (acc, method) => acc + method.rows,
          0
        );
        // calculate percentage rounded to 0 decimal places
        const percentage = Math.round((size / maxRows) * 100);

        console.log(
          `method's total size for a ${contract.name} is ${size} rows (${percentage}% of max ${maxRows} rows)`
        );
        if (contract.skip !== true)
          for (const method in contract.result) {
            console.log(method, `rows:`, (contract.result as any)[method].rows);
          }
      }

      console.time("compiled");
      console.log("Compiling contracts...");
      const cache: Cache = Cache.FileSystem("./cache");
      console.time("MapUpdate compiled");
      mapVerificationKey = (await MapUpdate.compile({ cache })).verificationKey;
      console.timeEnd("MapUpdate compiled");
      console.time("ValidatorsVoting compiled");
      validatorsVerificationKey = (await ValidatorsVoting.compile({ cache }))
        .verificationKey;
      console.timeEnd("ValidatorsVoting compiled");
      console.time("BlockContract compiled");
      blockVerificationKey = (await BlockContract.compile({ cache }))
        .verificationKey;
      console.timeEnd("BlockContract compiled");
      console.time("RollupContract compiled");
      contractVerificationKey = (await RollupContract.compile({ cache }))
        .verificationKey;
      console.timeEnd("RollupContract compiled");
      console.timeEnd("compiled");
      console.log(
        "contract verification key",
        contractVerificationKey.hash.toJSON()
      );
      console.log("block verification key", blockVerificationKey.hash.toJSON());
      Memory.info("compiled");
    });

    it(`should deploy contract`, async () => {
      console.log(`Deploying contract...`);

      await fetchMinaAccount({ publicKey: sender, force: true });

      const tx = await Mina.transaction(
        {
          sender,
          fee: await fee(),
          memo: "MinaNFT: deploy",
        },
        async () => {
          AccountUpdate.fundNewAccount(sender);
          await zkApp.deploy({});
          zkApp.validatorsPacked.set(validators.pack());
          zkApp.domain.set(Encoding.stringToFields("MinaNFT")[0]);
          zkApp.account.zkappUri.set("https://minanft.io");
        }
      );

      tx.sign([deployer, contractPrivateKey]);
      await sendTx(tx, "deploy");
      Memory.info("deployed");
      await sleep(30000);
      await fetchAccount({ publicKey: contractPublicKey });
      const validatorsPacked = zkApp.validatorsPacked.get();
      console.log("validatorsPacked:", validatorsPacked.toJSON());
      expect(validatorsPacked).toBeDefined();
      expect(validatorsPacked.toBigInt()).toBe(validators.pack().toBigInt());
    });

    it(`should sent block 0`, async () => {
      console.log(`Sending block 0...`);
      Memory.info("sending block 0");
      await fetchMinaAccount({ publicKey: sender, force: true });
      await fetchMinaAccount({ publicKey: contractPublicKey, force: true });

      const tx = await Mina.transaction(
        { sender, fee: await fee(), memo: "MinaNFT: block 0" },
        async () => {
          AccountUpdate.fundNewAccount(sender);
          await zkApp.blockZero(
            nameContract.firstBlockPublicKey!,
            UInt64.from(Date.now())
          );
        }
      );
      await tx.prove();
      tx.sign([deployer, nameContract.firstBlockPrivateKey!]);
      await sendTx(tx, "block 0");
      Memory.info("block 0 sent");
      await sleep(30000);
      //console.log("PINATA_JWT:", process.env.PINATA_JWT);
    });
  }

  if (!deploy) {
    it.skip(`should restart the sequencer`, async () => {
      console.log(`Restarting sequencer...`);
      let args: string = JSON.stringify({
        contractAddress: contractPublicKey.toBase58(),
      });
      let apiresult = await api.execute({
        repo: "nameservice",
        task: "restart",
        transactions: [],
        args,
        developer: "@staketab",
        metadata: `txTask`,
        mode: "sync",
      });
      expect(apiresult).toBeDefined();
      if (apiresult === undefined) return;
      expect(apiresult.success).toBe(true);
    });
  }

  it(`should add task to process transactions`, async () => {
    console.log(`Adding task to process transactions...`);
    let args: string = JSON.stringify({
      contractAddress: contractPublicKey.toBase58(),
    });
    const apiresult = await api.execute({
      repo,
      task: "createTxTask",
      transactions: [],
      args,
      developer,
      metadata: `txTask`,
      mode: "sync",
    });
    console.log(`api call result:`, apiresult);
    expect(apiresult).toBeDefined();
    if (apiresult === undefined) return;
    expect(apiresult.success).toBe(true);
    console.log(`Processing tasks...`);
    while (
      (await LocalCloud.processLocalTasks({
        developer,
        repo,
        localWorker: zkcloudworker,
        chain,
      })) > 1
    ) {
      await sleep(10000);
    }
  });

  it(`should send transactions for first block`, async () => {
    console.time(`Txs to the block sent`);
    const apiresult = await api.sendTransactions({
      repo,
      developer,
      transactions: addTransactions,
    });
    expect(apiresult).toBeDefined();
    if (apiresult === undefined) return;
    expect(apiresult.success).toBe(true);
    console.log(`tx api call result:`, apiresult);
    console.timeEnd(`Txs to the block sent`);

    console.log(`Processing tasks...`);
    while (
      (await LocalCloud.processLocalTasks({
        developer,
        repo,
        localWorker: zkcloudworker,
        chain,
      })) > 1
    ) {
      await sleep(10000);
    }
    Memory.info(`tasks processed`);
  });

  it(`should get Rollup's NFT URLs and uri from the DA layer`, async () => {
    await getDatabase();
  });

  if (update) {
    it(`should prepare second block data`, async () => {
      console.log("Preparing data...");
      console.time(`prepared data`);

      for (let k = 0; k < ELEMENTS_NUMBER; k++) {
        const oldDomain = database.data[users[k].name];
        console.log(`old domain:`, oldDomain);
        const tx1 = await createUpdateTransaction(
          users[k].name,
          users[k].privateKey.toPublicKey().toBase58(),
          oldDomain
        );
        expect(tx1).toBeDefined();
        if (tx1 === undefined) throw new Error("Transaction is undefined");
        console.log(`tx1:`, tx1);
        const tx2 = await prepareSignTransactionData(tx1);
        console.log(`tx2:`, tx2);
        await sleep(5000);
        expect(tx2).toBeDefined();
        if (tx2 === undefined) throw new Error("Transaction is undefined");
        expect(tx2.signature).toBeDefined();
        if (tx2.signature === undefined)
          throw new Error("Signature is undefined");
        const signData = JSON.parse(tx2.signature).signatureData.map(
          (v: string) => Field.fromJSON(v)
        );
        const signature = Signature.create(users[k].privateKey, signData);
        tx2.signature = signature.toBase58();
        updateTransactions.push(JSON.stringify(tx2, null, 2));
      }

      console.timeEnd(`prepared data`);
    });

    it(`should send transactions for second block`, async () => {
      console.time(`Txs to the block sent`);
      const apiresult = await api.sendTransactions({
        repo: "nameservice",
        developer: "@staketab",
        transactions: updateTransactions,
      });
      expect(apiresult).toBeDefined();
      if (apiresult === undefined) return;
      expect(apiresult.success).toBe(true);
      console.log(`tx api call result:`, apiresult);
      console.timeEnd(`Txs to the block sent`);

      console.log(`Processing tasks...`);
      while (
        (await LocalCloud.processLocalTasks({
          developer,
          repo,
          localWorker: zkcloudworker,
          chain,
        })) > 1
      ) {
        await sleep(10000);
      }
      Memory.info(`tasks processed`);
    });

    it(`should get Rollup's NFT URLs and uri from the DA layer`, async () => {
      await getDatabase();
    });

    it(`should change validators`, async () => {
      console.log(`Changing validators...`);
      Memory.info("changing validators");
      const expiry = UInt64.from(Date.now() + 1000 * 60 * 60 * 24 * 2000);
      const decision = new ValidatorsDecision({
        contractAddress: contractPublicKey,
        chainId: getNetworkIdHash(),
        validators,
        decisionType: ValidatorDecisionType.setValidators,
        data: ChangeValidatorsData.toFields({
          new: validators,
          old: validators,
          storage: new Storage({ hashString: [Field(0), Field(0)] }),
        }),
        expiry,
      });
      const proof: ValidatorsVotingProof = await calculateValidatorsProof(
        decision,
        validatorsVerificationKey,
        false
      );
      const ok = await verify(proof.toJSON(), validatorsVerificationKey);
      console.log("proof verified:", { ok });
      expect(ok).toBe(true);
      if (!ok) throw new Error("Proof is not verified");

      await fetchMinaAccount({ publicKey: sender, force: true });
      await fetchMinaAccount({ publicKey: contractPublicKey, force: true });

      const tx = await Mina.transaction(
        { sender, fee: await fee(), memo: "change validators" },
        async () => {
          await zkApp.setValidators(proof);
        }
      );
      Memory.info("proving");
      console.log("proving...");
      await tx.prove();
      Memory.info("signing");
      console.log("signing...");
      tx.sign([deployer]);
      Memory.info("sending");
      console.log("sending...");
      await sendTx(tx, "Change validators");
      Memory.info("validators changed");
    });
  }
});

async function prepareSignTransactionData(
  tx: DomainSerializedTransaction
): Promise<DomainSerializedTransaction | undefined> {
  console.log(`test prepareSignTransactionData tx`, tx);
  const answer = await api.execute({
    repo,
    task: "prepareSignTransactionData",
    transactions: [],
    args: JSON.stringify({ tx, contractAddress: contractPublicKey.toBase58() }),
    developer,
    metadata: `sign`,
    mode: "sync",
  });
  console.log(`test prepareSignTransactionData api call result:`, answer);
  expect(answer).toBeDefined();
  expect(answer.success).toBe(true);
  expect(answer.result).toBeDefined();
  expect(answer.result.slice(5)).not.toBe("error");
  try {
    const data = JSON.parse(answer.result) as DomainSerializedTransaction;
    console.log(`test prepareSignTransactionData result tx:`, data);
    return data;
  } catch (error: any) {
    console.error(`Error in prepareSignTransactionData:`, error);
  }
  return undefined;
}

async function getDatabase() {
  const blocks = await api.execute({
    repo,
    task: "getBlocksInfo",
    transactions: [],
    args: JSON.stringify({
      contractAddress: contractPublicKey.toBase58(),
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
  console.log(`blocks:`, data);
  const lastProvedBlockNumber =
    data?.contractState?.lastProvedBlock.blockNumber;
  console.log(`last proved block number:`, lastProvedBlockNumber);
  expect(lastProvedBlockNumber).toBeDefined();
  const blocksList: object[] = data?.blocks;
  // find the last proved block
  let index = -1;
  for (let i = 0; i < blocksList.length; i++) {
    if (
      Number((blocksList[i] as any).blockNumber) ===
      Number(lastProvedBlockNumber)
    ) {
      index = i;
      break;
    }
  }
  console.log(`index:`, index);
  expect(index).toBeDefined();
  expect(index).toBeGreaterThanOrEqual(0);
  expect(index).toBeLessThan(data.blocks.length);
  const ipfs = data?.blocks[index].ipfs;
  console.log(`last proved block ipfs hash:`, ipfs);
  expect(ipfs).toBeDefined();
  if (ipfs === undefined) return;
  const blockData = await loadFromIPFS(ipfs);
  console.log(`block data:`, blockData);
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
}

async function sendTx(
  tx: Mina.Transaction<false, true> | Mina.Transaction<true, true>,
  description?: string
) {
  try {
    let txSent;
    let sent = false;
    while (!sent) {
      txSent = await tx.safeSend();
      if (txSent.status == "pending") {
        sent = true;
        console.log(
          `${description ?? ""} tx sent: hash: ${txSent.hash} status: ${
            txSent.status
          }`
        );
      } else if (chain === "zeko") {
        console.log("Retrying Zeko tx");
        await sleep(10000);
      } else {
        console.log(
          `${description ?? ""} tx NOT sent: hash: ${txSent?.hash} status: ${
            txSent?.status
          }`
        );
        return "Error sending transaction";
      }
    }
    if (txSent === undefined) throw new Error("txSent is undefined");
    if (txSent.errors.length > 0) {
      console.error(
        `${description ?? ""} tx error: hash: ${txSent.hash} status: ${
          txSent.status
        }  errors: ${txSent.errors}`
      );
    }

    if (txSent.status === "pending") {
      console.log(`Waiting for tx inclusion...`);
      const txIncluded = await txSent.safeWait();
      console.log(
        `${description ?? ""} tx included into block: hash: ${
          txIncluded.hash
        } status: ${txIncluded.status}`
      );
    }
  } catch (error) {
    if (chain !== "zeko") console.error("Error sending tx", error);
  }
  if (chain !== "local") await sleep(10000);
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

async function createAddTransaction(
  name: string,
  address: string
): Promise<DomainSerializedTransaction> {
  const tx: DomainSerializedTransaction = {
    operation: "add",
    name,
    address,
    expiry: Date.now() + 1000 * 60 * 60 * 24 * 365,
    metadata: JSON.stringify({
      contractAddress: contractPublicKey.toBase58(),
    }),
  } as DomainSerializedTransaction;
  return tx;
}

async function createUpdateTransaction(
  name: string,
  address: string,
  oldDomain: string
): Promise<DomainSerializedTransaction | undefined> {
  const keys = [
    {
      friend1: uniqueNamesGenerator({
        dictionaries: [names],
        length: 1,
      }),
    },
    {
      friend2: uniqueNamesGenerator({
        dictionaries: [names],
        length: 1,
      }),
    },
    { chain },
  ];

  const image: ImageData = {
    size: 287846,
    mimeType: "image/jpeg",
    sha3_512:
      "qRm+FYlhRb1DHngZ0rIQHXAfMS1yTi6exdbfzrBJ/Dl1WuzCuif1v4UDsH4zY+tBFEVctBnHo2Ojv+0LBuydBw==",
    filename: "image.jpg",
    ipfsHash: "bafybeigkvkjhk7iii7b35u4e6ljpbtf5a6jdmzp3qdrn2odx76pubwvc4i",
  } as ImageData;

  const description =
    "This is a description of Rollup NFT for Mina Domain Name Service";

  const tx: DomainSerializedTransaction = {
    operation: "update",
    name,
    address,
    oldDomain,
    expiry: Date.now() + 1000 * 60 * 60 * 24 * 365,
    metadata: JSON.stringify({
      keys,
      image,
      description,
      contractAddress: contractPublicKey.toBase58(),
    }),
  } as DomainSerializedTransaction;

  return tx;
}
