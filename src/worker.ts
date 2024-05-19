import {
  zkCloudWorker,
  Cloud,
  fee,
  DeployedSmartContract,
  sleep,
  getNetworkIdHash,
  CloudTransaction,
  makeString,
  accountBalanceMina,
  deserializeFields,
  serializeFields,
  stringHash,
} from "zkcloudworker";
import os from "os";
import assert from "node:assert/strict";
import {
  verify,
  JsonProof,
  VerificationKey,
  Field,
  PublicKey,
  Mina,
  PrivateKey,
  AccountUpdate,
  UInt64,
  Bool,
  Signature,
  MerkleMap,
  Encoding,
  fetchAccount,
  Cache,
} from "o1js";
import {
  MapTransition,
  MapUpdate,
  MapUpdateData,
  MapUpdateProof,
  DomainTransactionData,
  RollupNftName,
  DomainTransaction,
  DomainTransactionEnum,
  RollupNftNameValue,
  DomainSerializedTransaction,
  DomainCloudTransaction,
  DomainCloudTransactionData,
  DomainCloudTransactionStatus,
} from "./rollup/transaction";
import { Storage } from "./contract/storage";
import {
  ValidatorsDecision,
  ValidatorsVoting,
  ValidatorsVotingProof,
  ValidatorDecisionType,
} from "./rollup/validators";
import {
  RollupContract,
  BlockContract,
  BlockData,
  BlockParams,
  BlockCreationData,
  BlockValidationData,
  BadBlockValidationData,
  LastBlock,
} from "./contract/domain-contract";
import {
  calculateValidatorsProof,
  getValidators,
} from "./rollup/validators-proof";
import { createBlock } from "./rollup/blocks";
import { treeFromJSON, treeToJSON } from "./lib/map-json";
import { DomainDatabase } from "./rollup/database";
import { saveToIPFS, loadFromIPFS } from "./contract/storage";
import { blockProducer } from "./config";
import { stringToFields, stringFromFields } from "./lib/hash";
import { nameContract } from "./config";
import { RollupNFTData, createRollupNFT } from "./rollup/rollup-nft";
import { Metadata } from "minanft";
import { algoliaWriteToken } from "./nft/algolia";
import { algoliaWriteBlock } from "./nft";
import { write } from "fs";

const fullValidation = true;
const proofsOff = false as boolean;

export class RollupWorker extends zkCloudWorker {
  static mapUpdateVerificationKey: VerificationKey | undefined = undefined;
  static contractVerificationKey: VerificationKey | undefined = undefined;
  static blockContractVerificationKey: VerificationKey | undefined = undefined;
  static validatorsVerificationKey: VerificationKey | undefined = undefined;
  readonly cache: Cache;
  readonly MIN_TIME_BETWEEN_BLOCKS = 1000 * 60 * 1; // 1 minutes
  readonly MAX_TIME_BETWEEN_BLOCKS = 1000 * 60 * 60; // 60 minutes
  readonly MIN_TRANSACTIONS = 1;
  readonly MAX_TRANSACTIONS = 5;

  constructor(cloud: Cloud) {
    super(cloud);
    this.cache = Cache.FileSystem(this.cloud.cache);
  }
  public async deployedContracts(): Promise<DeployedSmartContract[]> {
    throw new Error("not implemented");
  }

  private async compile(compileSmartContracts: boolean = true): Promise<void> {
    try {
      console.log("Available parallelism:", os.availableParallelism());
      console.time("compiled");
      if (RollupWorker.mapUpdateVerificationKey === undefined) {
        console.time("compiled MapUpdate");
        RollupWorker.mapUpdateVerificationKey = (
          await MapUpdate.compile({
            cache: this.cache,
          })
        ).verificationKey;
        console.timeEnd("compiled MapUpdate");
      }

      if (compileSmartContracts === false) {
        console.timeEnd("compiled");
        return;
      }

      if (RollupWorker.blockContractVerificationKey === undefined) {
        console.time("compiled BlockContract");
        RollupWorker.blockContractVerificationKey = (
          await BlockContract.compile({
            cache: this.cache,
          })
        ).verificationKey;
        console.timeEnd("compiled BlockContract");
      }
      if (RollupWorker.validatorsVerificationKey === undefined) {
        console.time("compiled ValidatorsVoting");
        RollupWorker.validatorsVerificationKey = (
          await ValidatorsVoting.compile({
            cache: this.cache,
          })
        ).verificationKey;
        console.timeEnd("compiled ValidatorsVoting");
      }

      if (RollupWorker.contractVerificationKey === undefined) {
        console.time("compiled RollupContract");
        RollupWorker.contractVerificationKey = (
          await RollupContract.compile({
            cache: this.cache,
          })
        ).verificationKey;
        console.timeEnd("compiled RollupContract");
      }
      console.timeEnd("compiled");
    } catch (error) {
      console.error("Error in compile, restarting container", error);
      // Restarting the container, see https://github.com/o1-labs/o1js/issues/1651
      await this.cloud.forceWorkerRestart();
      throw error;
    }
  }

  public async create(transaction: string): Promise<string | undefined> {
    try {
      const msg = `proof created with proofs ${
        proofsOff === true ? "off" : "on"
      }`;
      console.time(msg);
      const args = JSON.parse(transaction);
      if (proofsOff === false) {
        const state: MapTransition = MapTransition.fromFields(
          deserializeFields(args.state)
        ) as MapTransition;
        // TODO: handle all operations
        const isAccepted = args.isAccepted;
        const updateType = args.type;
        const signature = args.signature
          ? (Signature.fromBase58(args.signature) as Signature)
          : undefined;
        const oldDomain = args.oldDomain
          ? (RollupNftName.fromFields(
              deserializeFields(args.oldDomain)
            ) as RollupNftName)
          : undefined;
        const oldRoot = args.oldRoot ? Field.fromJSON(args.oldRoot) : undefined;
        const time = args.time ? UInt64.from(BigInt(args.time)) : undefined;
        const tx = args.tx
          ? (DomainTransaction.fromFields(
              deserializeFields(args.tx)
            ) as DomainTransaction)
          : undefined;

        if (isAccepted === undefined)
          throw new Error("isAccepted is undefined");
        if (updateType === undefined)
          throw new Error("updateType is undefined");
        if (
          updateType !== "add" &&
          updateType !== "remove" &&
          updateType !== "update" &&
          updateType !== "extend"
        )
          throw new Error("updateType is invalid");

        if (
          isAccepted === false &&
          (time === undefined || tx === undefined || oldRoot === undefined)
        )
          throw new Error("time, tx or oldRoot is undefined");

        await this.compile(false);
        if (RollupWorker.mapUpdateVerificationKey === undefined)
          throw new Error("verificationKey is undefined");

        let proof: MapUpdateProof;
        if (isAccepted === true) {
          if (
            updateType === "update" &&
            (oldDomain === undefined || signature === undefined)
          )
            throw new Error("oldDomain or signature is undefined");
          if (updateType === "extend" && oldDomain === undefined)
            throw new Error("oldDomain is undefined");

          const update: MapUpdateData = MapUpdateData.fromFields(
            deserializeFields(args.update)
          ) as MapUpdateData;
          if (update === undefined) throw new Error("update is undefined");
          if (updateType === undefined)
            throw new Error("updateType is undefined");
          if (updateType === "add") {
            proof = await MapUpdate.add(state, update);
          } else if (updateType === "remove") {
            proof = await MapUpdate.remove(state, update);
          } else if (updateType === "update") {
            if (update === undefined) throw new Error("update is undefined");
            if (oldDomain === undefined)
              throw new Error("oldDomain is undefined");
            if (signature === undefined)
              throw new Error("signature is undefined");
            const txSignature: Signature = signature;
            const txUpdate: MapUpdateData = update;
            const txDomain: RollupNftName = oldDomain;
            proof = await MapUpdate.update(
              state,
              txUpdate,
              txDomain,
              txSignature
            );
          } else if (updateType === "extend") {
            if (update === undefined) throw new Error("update is undefined");
            if (oldDomain === undefined)
              throw new Error("oldDomain is undefined");
            const txUpdate: MapUpdateData = update;
            const txDomain: RollupNftName = oldDomain;
            proof = await MapUpdate.extend(state, txUpdate, txDomain);
          } else {
            throw new Error("invalid updateType");
          }
        } else {
          if (time === undefined || tx === undefined || oldRoot === undefined)
            throw new Error("time, tx or oldRoot is undefined");
          proof = await MapUpdate.reject(state, oldRoot, time, tx);
        }

        const ok = await verify(
          proof.toJSON(),
          RollupWorker.mapUpdateVerificationKey
        );
        if (!ok) throw new Error("proof verification failed");
        console.timeEnd(msg);
        return JSON.stringify(proof.toJSON(), null, 2);
      } else {
        //console.log("Proofs are off, returning state as is");
        console.timeEnd(msg);
        return args.state;
      }
    } catch (error) {
      console.error("Error in create", error);
      await this.cloud.forceWorkerRestart();
    }
  }
  public async merge(
    proof1: string,
    proof2: string
  ): Promise<string | undefined> {
    try {
      const msg = `proof merged with proofs ${
        proofsOff === true ? "off" : "on"
      }`;
      console.time(msg);
      if (proofsOff === false) {
        await this.compile(false);
        try {
          if (RollupWorker.mapUpdateVerificationKey === undefined)
            throw new Error("verificationKey is undefined");

          const sourceProof1: MapUpdateProof = await MapUpdateProof.fromJSON(
            JSON.parse(proof1) as JsonProof
          );
          const sourceProof2: MapUpdateProof = await MapUpdateProof.fromJSON(
            JSON.parse(proof2) as JsonProof
          );
          const state = MapTransition.merge(
            sourceProof1.publicInput,
            sourceProof2.publicInput
          );
          const proof = await MapUpdate.merge(
            state,
            sourceProof1,
            sourceProof2
          );
          const ok = await verify(
            proof.toJSON(),
            RollupWorker.mapUpdateVerificationKey
          );
          if (!ok) throw new Error("proof verification failed");
          console.timeEnd(msg);
          return JSON.stringify(proof.toJSON(), null, 2);
        } catch (error) {
          console.log("Error in merge", error);
          console.timeEnd(msg);
          throw error;
        }
      } else {
        //console.log("Proofs are off, merging state");
        const state1: MapTransition = MapTransition.fromFields(
          deserializeFields(proof1)
        ) as MapTransition;
        const state2: MapTransition = MapTransition.fromFields(
          deserializeFields(proof2)
        ) as MapTransition;
        const state = MapTransition.merge(state1, state2);
        console.timeEnd(msg);
        return serializeFields(MapTransition.toFields(state));
      }
    } catch (error) {
      console.error("Error in create", error);
      await this.cloud.forceWorkerRestart();
    }
  }

  public async execute(transactions: string[]): Promise<string | undefined> {
    switch (this.cloud.task) {
      case "createTxTask":
        return await this.createTxTask();
      case "getBlocksInfo":
        return await this.getBlocksInfo({});
      case "getMetadata":
        return await this.getMetadata();
      case "restart":
        return await this.restart();
      case "prepareSignTransactionData":
        return await this.prepareSignTransactionData();
      case "rollupNFT":
        return JSON.stringify(await this.rollupNFT(transactions));
      case "processTransactions":
        let result = "error";
        try {
          result =
            (await this.txTask(true)) ?? "error in processTransactions: txTask";
        } catch (error) {
          console.error("Error: catch: processTransactions: txTask", error);
        }
        await this.createTxTask();
        return result;
      default:
        console.error("Unknown task in execute:", this.cloud.task);
        return "Unknown task in execute";
    }
  }

  public async task(): Promise<string | undefined> {
    if (this.cloud.task === undefined) throw new Error("task is undefined");
    console.log(
      `Executing task ${this.cloud.task} with taskId ${this.cloud.taskId}`
    );
    if (!(await this.run()))
      return `task ${this.cloud.task} is already running`;
    let result: string | undefined = undefined;
    try {
      switch (this.cloud.task) {
        case "validateBlock":
          result = await this.validateRollupBlock();
          break;
        case "proveBlock":
          result = await this.proveRollupBlock();
          break;
        case "txTask":
          result = await this.txTask();
          break;

        default:
          console.error("Unknown task in task:", this.cloud.task);
      }
      await this.stop();
      return result ?? "error in task";
    } catch (error) {
      console.error("Error in task", error);
      await this.stop();
      return "error in task";
    }
  }

  private async txTask(forced: boolean = false): Promise<string | undefined> {
    if (forced === false) {
      const txToken = await this.cloud.getDataByKey("txToken");
      if (txToken === undefined) {
        console.error("txToken is undefined, exiting");
        await this.cloud.deleteTask(this.cloud.taskId);
        return "exiting txTask due to undefined txToken";
      }
      if (this.cloud.args === undefined) {
        console.error("cloud.args are undefined, exiting");
        await this.cloud.deleteTask(this.cloud.taskId);
        return "exiting txTask due to undefined cloud.args";
      }
      if (txToken !== JSON.parse(this.cloud.args).txToken) {
        console.log("txToken is replaced, exiting");
        await this.cloud.deleteTask(this.cloud.taskId);
        return "exiting txTask due to replaced txToken";
      }
      const timeStarted = await this.cloud.getDataByKey("txTask.timeStarted");
      if (
        timeStarted !== undefined &&
        Date.now() - Number(timeStarted) < 1000 * 60
      ) {
        console.error(
          "txTask is already running, detected double invocation, exiting"
        );
        if (this.cloud.isLocalCloud === false)
          return "exiting txTask due to double invocation";
      }
      await this.cloud.saveDataByKey(
        "txTask.timeStarted",
        Date.now().toString()
      );
    }

    const transactions = await this.cloud.getTransactions();
    console.log(
      `txTask with ${transactions.length} transaction(s), forced: ${forced}`
    );
    if (transactions.length !== 0) {
      // sort by timeReceived, ascending
      transactions.sort((a, b) => a.timeReceived - b.timeReceived);
      console.log(
        `Executing txTask with ${
          transactions.length
        } transactions, first tx created at ${new Date(
          transactions[0].timeReceived
        ).toLocaleString()}...`
      );
      try {
        // TODO: Use processTransactions ???
        const result = await this.createRollupBlock(transactions);
        return result;
      } catch (error) {
        console.error("Error in txTask", error);
        return "Error in txTask";
      }
    }
    return "no transactions to process";
  }

  private async run(): Promise<boolean> {
    const taskId = this.cloud.taskId;
    if (taskId === undefined) {
      console.error("taskId is undefined", this.cloud);
      return false;
    }
    const statusId = "task.status." + taskId;
    const status = await this.cloud.getDataByKey(statusId);
    if (status === undefined) {
      await this.cloud.saveDataByKey(statusId, Date.now().toString());
      return true;
    } else if (Date.now() - Number(status) > 1000 * 60 * 15) {
      console.error(
        "Task is running for more than 15 minutes, restarting",
        this.cloud
      );
      await this.cloud.saveDataByKey(statusId, Date.now().toString());
      return true;
    } else {
      console.log("Task is already running", taskId);
      return false;
    }
  }

  private async stop() {
    const taskId = this.cloud.taskId;
    const statusId = "task.status." + taskId;
    await this.cloud.saveDataByKey(statusId, undefined);
  }

  private async getMetadata(): Promise<string | undefined> {
    try {
      if (this.cloud.args === undefined) {
        console.error("getMetadata: args are undefined");
        return "error";
      }
      const args = JSON.parse(this.cloud.args);
      const contractAddress = PublicKey.fromBase58(args.contractAddress);
      if (contractAddress === undefined) {
        console.error("getMetadata: contractAddress is undefined");
        return "error: getMetadata: contractAddress is undefined";
      }
      if (contractAddress.toBase58() !== nameContract.contractAddress) {
        console.error("getMetadata: contractAddress is invalid");
        return "error: getMetadata: contractAddress is invalid";
      }
      const serializedDomain = args.domain;
      const domain = RollupNftName.fromFields(
        deserializeFields(serializedDomain)
      );
      const name = stringFromFields([domain.name]);
      const ipfs = domain.data.storage.toIpfsHash();
      const uri = "https://gateway.pinata.cloud/ipfs/" + ipfs;
      const url = "https://minanft.io/nft/i" + ipfs;
      const nft = await loadFromIPFS(ipfs);
      const address = domain.data.address.toBase58();
      const expiry = domain.data.expiry.toBigInt().toString();
      const data = { name, address, ipfs, expiry, uri, url, nft };
      return JSON.stringify(data, null, 2);
    } catch (error) {
      console.error("Error in getMetadata", error);
      return "Error in getMetadata";
    }
  }

  private async sendToAlgolia(
    tx: DomainTransaction,
    contractAddress: string
  ): Promise<boolean> {
    try {
      const domain = tx.domain;
      const name = stringFromFields([domain.name]);
      const ipfs = domain.data.storage.toIpfsHash();
      const uri = "https://gateway.pinata.cloud/ipfs/" + ipfs;
      const url = "https://minanft.io/nft/i" + ipfs;
      const token = await loadFromIPFS(ipfs);
      const address = domain.data.address.toBase58();
      const expiry = domain.data.expiry.toBigInt().toString();
      console.log("sendToAlgolia", { name, address, ipfs, expiry, uri, url });
      const success = algoliaWriteToken({
        token,
        name,
        address,
        chain: this.cloud.chain,
        ipfs,
        explorerAccount: `https://zekoscan.io/devnet/account/${contractAddress}/txs?type=zk-acc`,
      });
      return success;
    } catch (error) {
      console.error("Error in rollupNFT", error);
      return false;
    }
  }

  private async rollupNFT(transactions: string[]): Promise<{
    success: boolean;
    transactions?: CloudTransaction[];
    error?: string;
  }> {
    try {
      if (this.cloud.args === undefined) {
        console.error("getMetadata: args are undefined");
        return {
          success: false,
          error: "error: rollupNFT: args are undefined",
        };
      }
      const args = JSON.parse(this.cloud.args);
      const contractAddress = PublicKey.fromBase58(args.contractAddress);
      if (contractAddress === undefined) {
        console.error("rollupNFT: contractAddress is undefined");
        return {
          success: false,
          error: "error: rollupNFT: contractAddress is undefined",
        };
      }
      if (contractAddress.toBase58() !== nameContract.contractAddress) {
        console.error("rollupNFT: contractAddress is invalid");
        return {
          success: false,
          error: "error: rollupNFT: contractAddress is invalid",
        };
      }
      const txs: CloudTransaction[] = [];
      for (const tx of transactions) {
        const timeReceived = Date.now();
        const transaction =
          tx !== undefined
            ? typeof tx === "string"
              ? tx
              : "tx is not a string"
            : "undefined tx";
        const txId = stringHash(
          JSON.stringify({ tx: transaction, time: timeReceived })
        );
        if (transaction !== tx) {
          console.error("Error in transaction", tx);
          const ct: CloudTransaction = {
            status: "invalid",
            transaction,
            txId,
            timeReceived,
          };
          txs.push(ct);
        }
        try {
          const txParsed: DomainSerializedTransaction = JSON.parse(
            transaction
          ) as DomainSerializedTransaction;
          const deserializedTransaction =
            await RollupWorker.deserializeTransaction(txParsed);
          const ct: CloudTransaction = {
            status: deserializedTransaction.status,
            transaction,
            txId,
            timeReceived,
          };
          txs.push(ct);
          if (
            deserializedTransaction.status !== "pending" ||
            deserializedTransaction.tx === undefined
          ) {
            console.error(
              "Error in deserializing transaction:",
              deserializedTransaction
            );
          } else {
            const success = await this.sendToAlgolia(
              deserializedTransaction.tx,
              contractAddress.toBase58()
            );
            if (!success) {
              console.error("Error in sendToAlgolia");
            }
          }
        } catch (error) {
          const tx: CloudTransaction = {
            status: "invalid",
            transaction,
            txId,
            timeReceived,
          };
          txs.push(tx);
        }
      }
      await this.cloud.sendTransactions(txs);
      await this.cloud.execute({
        transactions: [],
        task: "processTransactions",
        args: JSON.stringify({ contractAddress: contractAddress.toBase58() }),
        metadata: `rollupNFT with ${transactions.length} transactions`,
      });
      await algoliaWriteBlock({
        contractAddress: contractAddress.toBase58(),
        chain: this.cloud.chain,
        txs,
      });
      return { success: true, transactions: txs };
    } catch (error) {
      console.error("Error in rollupNFT", error);
      return { success: false, error: "error in rollupNFT" };
    }
  }

  private async getBlocksInfo(params: {
    startBlock?: PublicKey;
    writeToAlgolia?: boolean;
  }): Promise<string | undefined> {
    const MAX_BLOCKS = 3;
    try {
      let { startBlock, writeToAlgolia } = params;
      let contractAddress: PublicKey | undefined = undefined;
      let allBlocks: boolean = false;
      if (this.cloud.args !== undefined) {
        const args = JSON.parse(this.cloud.args);
        console.log("getBlocksInfo", args);
        startBlock =
          args.startBlock === undefined
            ? undefined
            : PublicKey.fromBase58(args.startBlock);
        contractAddress = PublicKey.fromBase58(args.contractAddress);
        allBlocks = args.allBlocks === true;
        console.log("getBlocksInfo", { args, allBlocks });
      }
      if (contractAddress === undefined) {
        console.error("getBlocksInfo: contractAddress is undefined");
        return "getBlocksInfo: contractAddress is undefined";
      }
      if (contractAddress.toBase58() !== nameContract.contractAddress) {
        console.error("getBlocksInfo: contractAddress is invalid");
        return "getBlocksInfo: contractAddress is invalid";
      }
      const zkApp = new RollupContract(contractAddress);
      const tokenId = zkApp.deriveTokenId();
      await this.fetchMinaAccount({
        publicKey: contractAddress,
      });
      if (!Mina.hasAccount(contractAddress)) {
        console.error(
          `getBlocksInfo: Contract ${contractAddress.toBase58()} not found`
        );
        return `error: Contract ${contractAddress.toBase58()} not found`;
      }
      if (startBlock === undefined) {
        startBlock = LastBlock.unpack(zkApp.lastCreatedBlock.get()).address;
      }
      await this.fetchMinaAccount({ publicKey: startBlock, tokenId });
      if (!Mina.hasAccount(startBlock, tokenId)) {
        console.error(
          `getBlocksInfo: Block ${startBlock.toBase58()} not found`
        );
        return `error: Block ${startBlock.toBase58()} not found`;
      }
      let count = 0;
      const validators = getValidators(0).validators;
      const validatorsPacked = zkApp.validatorsPacked.get();
      if (validators.pack().toJSON() !== validatorsPacked.toJSON())
        throw new Error("Invalid validatorsPacked");
      const lastCreatedBlock = LastBlock.unpack(zkApp.lastCreatedBlock.get());
      const lastValidatedBlock = LastBlock.unpack(
        zkApp.lastValidatedBlock.get()
      );
      const lastProvedBlock = LastBlock.unpack(zkApp.lastProvedBlock.get());
      const contractState = {
        domain: Encoding.stringFromFields([zkApp.domain.get()]),
        validatorsPacked: validatorsPacked.toJSON(),
        lastCreatedBlock: {
          address: lastCreatedBlock.address.toBase58(),
          blockNumber: lastCreatedBlock.blockNumber.toBigInt().toString(),
        },
        lastValidatedBlock: {
          address: lastValidatedBlock.address.toBase58(),
          blockNumber: lastValidatedBlock.blockNumber.toBigInt().toString(),
        },
        lastProvedBlock: {
          address: lastProvedBlock.address.toBase58(),
          blockNumber: lastProvedBlock.blockNumber.toBigInt().toString(),
        },
      };
      let blockAddress = startBlock;
      let block = new BlockContract(blockAddress, tokenId);
      let blockNumber = Number(block.blockNumber.get().toBigInt());
      const blocks: {}[] = [];
      while ((count < MAX_BLOCKS || allBlocks) && blockNumber > 0) {
        const root = block.root.get().toJSON();
        const storage = block.storage.get().toIpfsHash();
        const flags = BlockParams.unpack(block.blockParams.get());
        const isValidated = flags.isValidated.toBoolean();
        const isInvalid = flags.isInvalid.toBoolean();
        const isProved = flags.isProved.toBoolean();
        const isFinal = flags.isFinal.toBoolean();
        const timeCreated = flags.timeCreated;
        const txsCount = flags.txsCount;
        const txsHash = block.txsHash.get().toJSON();
        const previousBlockAddress = block.previousBlock.get();
        blocks.push({
          blockNumber,
          blockAddress: blockAddress.toBase58(),
          root,
          ipfs: storage,
          isValidated,
          isInvalid,
          isProved,
          isFinal,
          timeCreated,
          txsCount,
          txsHash,
          previousBlockAddress: previousBlockAddress.toBase58(),
        });

        blockAddress = previousBlockAddress;
        block = new BlockContract(blockAddress, tokenId);
        await this.fetchMinaAccount({
          publicKey: blockAddress,
          tokenId,
          force: true,
        });
        blockNumber = Number(block.blockNumber.get().toBigInt());
        count++;
      }
      if (writeToAlgolia) {
        for (const block of blocks) {
          await algoliaWriteBlock({
            contractAddress: contractAddress.toBase58(),
            block,
            chain: this.cloud.chain,
          });
        }
      }
      return JSON.stringify(
        {
          contractAddress: contractAddress.toBase58(),
          startBlock: startBlock.toBase58(),
          blocks,
          contractState,
        },
        null,
        2
      );
    } catch (error) {
      console.error("Error in getBlocksInfo", error);
      return "Error in getBlocksInfo";
    }
  }

  private async restart(): Promise<string | undefined> {
    try {
      let startBlock: PublicKey | undefined = undefined;
      let contractAddress: PublicKey | undefined = undefined;
      if (this.cloud.args !== undefined) {
        const args = JSON.parse(this.cloud.args);
        startBlock =
          args.startBlock === undefined
            ? undefined
            : PublicKey.fromBase58(args.startBlock);
        contractAddress = PublicKey.fromBase58(args.contractAddress);
      }
      if (contractAddress === undefined) {
        console.error("getBlocksInfo: contractAddress is undefined");
        return "contractAddress is undefined";
      }
      if (contractAddress.toBase58() !== nameContract.contractAddress) {
        console.error("getBlocksInfo: contractAddress is invalid");
        return "contractAddress is invalid";
      }
      const zkApp = new RollupContract(contractAddress);
      const tokenId = zkApp.deriveTokenId();
      await this.fetchMinaAccount({
        publicKey: contractAddress,
      });
      if (!Mina.hasAccount(contractAddress)) {
        console.error(
          `getBlocksInfo: Contract ${contractAddress.toBase58()} not found`
        );
        return `error: Contract ${contractAddress.toBase58()} not found`;
      }
      if (startBlock === undefined) {
        startBlock = LastBlock.unpack(zkApp.lastCreatedBlock.get()).address;
      }
      await this.fetchMinaAccount({ publicKey: startBlock, tokenId });
      if (!Mina.hasAccount(startBlock, tokenId)) {
        console.error(
          `getBlocksInfo: Block ${startBlock.toBase58()} not found`
        );
        return `error: Block ${startBlock.toBase58()} not found`;
      }
      let blockAddress = startBlock;
      let block = new BlockContract(blockAddress, tokenId);
      let blockNumber = Number(block.blockNumber.get().toBigInt());
      let flags = BlockParams.unpack(block.blockParams.get());
      const blocks: { blockAddress: string; blockNumber: number }[] = [];
      while (flags.isFinal.toBoolean() === false && blockNumber > 0) {
        blocks.push({
          blockAddress: blockAddress.toBase58(),
          blockNumber: blockNumber,
        });

        const previousBlockAddress = block.previousBlock.get();
        blockAddress = previousBlockAddress;
        block = new BlockContract(blockAddress, tokenId);
        await this.fetchMinaAccount({
          publicKey: blockAddress,
          tokenId,
          force: true,
        });
        flags = BlockParams.unpack(block.blockParams.get());
        blockNumber = Number(block.blockNumber.get().toBigInt());
      }
      for (let i = blocks.length - 1; i >= 0; i--) {
        await this.cloud.addTask({
          args: JSON.stringify(
            {
              contractAddress: contractAddress.toBase58(),
              blockAddress: blocks[i].blockAddress,
              blockNumber: blocks[i].blockNumber,
            },
            null,
            2
          ),
          task: "validateBlock",
          metadata: `block ${blocks[i].blockNumber} validation (restart)`,
          userId: this.cloud.userId,
          maxAttempts: 20,
        });
      }

      return "validation restarted";
    } catch (error) {
      console.error("Error in getBlocksInfo", error);
      return "Error in getBlocksInfo";
    }
  }

  private async createTxTask(): Promise<string | undefined> {
    // TODO: add this.fetchMinaAccount and check that block validation tx is confirmed
    if (this.cloud.args === undefined)
      throw new Error("this.cloud.args is undefined");
    const args = JSON.parse(this.cloud.args);
    console.log(
      `Adding txTask, proofs off: ${proofsOff === true ? true : false}`
    );
    if (args.contractAddress === undefined)
      throw new Error("args.contractAddress is undefined");
    if (args.contractAddress !== nameContract.contractAddress) {
      console.error("getBlocksInfo: contractAddress is invalid");
      return "contractAddress is invalid";
    }
    const txToken = makeString(32);
    await this.cloud.saveDataByKey("txToken", txToken);
    const oldTxId = await this.cloud.getDataByKey("txTask.txId");
    const txId = await this.cloud.addTask({
      args: JSON.stringify(
        {
          contractAddress: args.contractAddress,
          txToken,
        },
        null,
        2
      ),
      task: "txTask",
      maxAttempts: 36,
      metadata: `tx processing: ${this.cloud.metadata ?? "backend"}`,
      userId: this.cloud.userId,
    });
    if (txId !== undefined) {
      await this.cloud.saveDataByKey("txTask.txId", txId);
      if (oldTxId !== undefined) await this.cloud.deleteTask(oldTxId);
    }
    return "txTask added";
  }

  private async proveRollupBlock(): Promise<string | undefined> {
    if (this.cloud.args === undefined)
      throw new Error("this.cloud.args is undefined");
    console.time("proveBlock");

    try {
      const args = JSON.parse(this.cloud.args);
      console.log(
        `Proving block ${args.blockNumber}, proofs off: ${proofsOff}`
      );
      if (args.contractAddress === undefined)
        throw new Error("args.contractAddress is undefined");
      if (args.contractAddress !== nameContract.contractAddress) {
        console.error("proveRollupBlock: contractAddress is invalid");
        return "contractAddress is invalid";
      }
      if (args.blockAddress === undefined)
        throw new Error("args.blockAddress is undefined");
      if (args.jobId === undefined) throw new Error("args.jobId is undefined");
      const job = await this.cloud.jobResult(args.jobId);
      if (job === undefined) throw new Error("job is undefined");
      if (job.result === undefined) {
        if (job.jobStatus === "failed") {
          console.error(`Proof job failed for block ${args.blockNumber}`);
          await this.cloud.deleteTask(this.cloud.taskId);
          console.timeEnd("proveBlock");

          return "proof job failed";
        } else {
          console.log(
            `Proof job is not finished yet for block ${args.blockNumber}`
          );
          console.timeEnd("proveBlock");

          return "proof job is not finished yet";
        }
      }

      let proof: MapUpdateProof;
      let state: MapTransition;
      if (proofsOff === false) {
        proof = await MapUpdateProof.fromJSON(
          JSON.parse(job.result) as JsonProof
        );
        state = proof.publicInput;
      } else {
        state = MapTransition.fromFields(
          deserializeFields(job.result)
        ) as MapTransition;
      }
      if (state === undefined) throw new Error("state is undefined");

      const contractAddress = PublicKey.fromBase58(args.contractAddress);
      const blockAddress = PublicKey.fromBase58(args.blockAddress);
      const blockNumber = args.blockNumber;
      const zkApp = new RollupContract(contractAddress);
      const tokenId = zkApp.deriveTokenId();
      await this.fetchMinaAccount({
        publicKey: blockAddress,
        tokenId,
        force: false,
      });
      if (!Mina.hasAccount(blockAddress, tokenId)) {
        console.log(`Block ${blockAddress.toBase58()} not found`);
        console.timeEnd("proveBlock");

        return "block is not found";
      }
      const block = new BlockContract(blockAddress, tokenId);
      const flags = BlockParams.unpack(block.blockParams.get());
      if (flags.isValidated.toBoolean() === false) {
        console.log(`Block ${blockNumber} is not yet validated`);
        console.timeEnd("proveBlock");

        return "block is not validated";
      }
      if (flags.isInvalid.toBoolean() === true) {
        console.error(`Block ${blockNumber} is invalid`);
        await this.cloud.deleteTask(this.cloud.taskId);
        console.timeEnd("proveBlock");

        return "block is invalid";
      }

      if (flags.isProved.toBoolean() === true) {
        console.error(`Block ${blockNumber} is already proved`);
        await this.cloud.deleteTask(this.cloud.taskId);
        console.timeEnd("proveBlock");

        return "block is already proved";
      }

      const previousBlockAddress = block.previousBlock.get();
      await this.fetchMinaAccount({
        publicKey: previousBlockAddress,
        tokenId,
        force: true,
      });
      if (!Mina.hasAccount(previousBlockAddress, tokenId)) {
        console.log(
          `Previous block ${previousBlockAddress.toBase58()} not found`
        );
        console.timeEnd("proveBlock");

        return "previous block is not found";
      }

      const previousBlock = new BlockContract(previousBlockAddress, tokenId);
      const oldRoot = previousBlock.root.get();
      if (oldRoot.toJSON() !== state.oldRoot.toJSON()) {
        console.error(`Invalid previous block root`);
        console.timeEnd("proveBlock");

        return "Invalid previous block root";
      }

      const flagsPrevious = BlockParams.unpack(previousBlock.blockParams.get());
      if (flagsPrevious.isFinal.toBoolean() === false) {
        console.log(`Previous block is not final`);
        console.timeEnd("proveBlock");

        return "Previous block is not final";
      } else {
        const previousBlockNumber = Number(
          previousBlock.blockNumber.get().toBigInt()
        );
        await this.cloud.saveDataByKey(
          `proofMap.${previousBlockNumber}.jobId`,
          undefined
        );
        await this.getBlocksInfo({
          startBlock: previousBlockAddress,
          writeToAlgolia: true,
        });
      }

      await this.compile();
      if (
        RollupWorker.mapUpdateVerificationKey === undefined ||
        RollupWorker.blockContractVerificationKey === undefined ||
        RollupWorker.validatorsVerificationKey === undefined ||
        RollupWorker.contractVerificationKey === undefined
      )
        throw new Error("verificationKey is undefined");

      const deployerKeyPair = await this.cloud.getDeployer();
      if (deployerKeyPair === undefined)
        throw new Error("deployer is undefined");
      const deployer = PrivateKey.fromBase58(deployerKeyPair.privateKey);
      const sender = deployer.toPublicKey();
      await this.fetchMinaAccount({ publicKey: sender, force: true });
      await this.fetchMinaAccount({ publicKey: contractAddress, force: true });
      await this.fetchMinaAccount({
        publicKey: blockAddress,
        tokenId,
        force: true,
      });
      await this.fetchMinaAccount({
        publicKey: previousBlockAddress,
        tokenId,
        force: true,
      });

      const tx = await Mina.transaction(
        {
          sender,
          fee: await fee(),
          memo: `MinaNFT: block ${blockNumber} is proved`,
        },
        async () => {
          proofsOff
            ? await zkApp.proveBlockProofsOff(state, blockAddress)
            : await zkApp.proveBlock(proof, blockAddress);
        }
      );

      await this.prove(tx);
      const txSent = await tx.sign([deployer]).safeSend();
      if (txSent.errors.length > 0) {
        console.error(
          `prove block tx error: hash: ${txSent.hash} status: ${txSent.status}  errors: ${txSent.errors}`
        );
      } else
        console.log(
          `prove block tx sent: hash: ${txSent.hash} status: ${txSent.status}`
        );
      if (txSent.status !== "pending") {
        await this.cloud.releaseDeployer({
          publicKey: deployerKeyPair.publicKey,
          txsHashes: [],
        });
        throw new Error("Error sending prove block transaction");
      }
      await this.cloud.releaseDeployer({
        publicKey: deployerKeyPair.publicKey,
        txsHashes: [txSent.hash],
      });
      //console.log("Deleting proveBlock task", this.cloud.taskId);
      console.log(`Block ${blockNumber} is proved`);
      await this.cloud.deleteTask(this.cloud.taskId);
      console.timeEnd("proveBlock");
      if (this.cloud.isLocalCloud === true) {
        if (this.cloud.chain !== "zeko") {
          const txIncluded = await txSent.safeWait();
          console.log(
            `prove block ${blockNumber} tx included into block: hash: ${txIncluded.hash} status: ${txIncluded.status}`
          );
        }
        await sleep(20000);
      }

      return txSent.hash;
    } catch (error) {
      console.error("Error in proveRollupBlock", error);

      return "Error in proveRollupBlock";
    }
  }

  private async validateRollupBlock(): Promise<string | undefined> {
    try {
      if (this.cloud.args === undefined)
        throw new Error("this.cloud.args is undefined");
      const args = JSON.parse(this.cloud.args);
      console.time(`block ${args.blockNumber} validated`);

      if (args.contractAddress === undefined)
        throw new Error("args.contractAddress is undefined");
      if (args.contractAddress !== nameContract.contractAddress) {
        console.error("validateRollupBlock: contractAddress is invalid");
        return "contractAddress is invalid";
      }
      if (args.blockAddress === undefined)
        throw new Error("args.blockAddress is undefined");
      let validated = true;
      let onlyRestartProving = false;
      let decision: ValidatorsDecision | undefined = undefined;
      let proofData: string[] = [];
      const contractAddress = PublicKey.fromBase58(args.contractAddress);
      const blockAddress = PublicKey.fromBase58(args.blockAddress);
      const zkApp = new RollupContract(contractAddress);
      const tokenId = zkApp.deriveTokenId();
      await this.fetchMinaAccount({ publicKey: contractAddress, force: true });
      const validators = getValidators(0).validators;
      const validatorsPacked = zkApp.validatorsPacked.get();
      if (validators.pack().toJSON() !== validatorsPacked.toJSON())
        throw new Error("Invalid validatorsPacked");
      let timeCreated = UInt64.from(0);
      let isPreviousBlockFinal: boolean = false;
      let previousBlockAddress: PublicKey | undefined = undefined;

      let blockNumber = 0;
      try {
        await this.fetchMinaAccount({
          publicKey: blockAddress,
          tokenId,
          force: false,
        });
        if (!Mina.hasAccount(blockAddress, tokenId)) {
          console.log(`Block ${blockAddress.toBase58()} not found`);
          console.timeEnd(`block ${args.blockNumber} validated`);

          return "block is not found";
        }

        const block = new BlockContract(blockAddress, tokenId);
        blockNumber = Number(block.blockNumber.get().toBigInt());
        previousBlockAddress = block.previousBlock.get();
        console.log(`Validating block ${blockNumber}...`);
        if (blockNumber === 0)
          throw new Error("validateRollupBlock: Block number is 0");
        const flags = BlockParams.unpack(block.blockParams.get());
        if (flags.isInvalid.toBoolean() === true) {
          console.log(`Block ${blockNumber} is marked as invalid`);
          await this.cloud.deleteTask(this.cloud.taskId);
          console.timeEnd(`block ${args.blockNumber} validated`);

          return `Block ${blockNumber} is marked as invalid`;
        }

        if (
          flags.isValidated.toBoolean() === true &&
          flags.isProved.toBoolean() === false
        ) {
          console.log(
            `Block ${blockNumber} is already validated, but not proved`
          );

          const jobId = await this.cloud.getDataByKey(
            `proofMap.${blockNumber}.jobId`
          );
          if (jobId === undefined) onlyRestartProving = true;
          else {
            const job = await this.cloud.jobResult(jobId);
            if (job == undefined) onlyRestartProving = true;
            else if (job.jobStatus === "failed") onlyRestartProving = true;
            else {
              if (job?.jobStatus)
                await this.cloud.addTask({
                  args: JSON.stringify(
                    {
                      contractAddress: args.contractAddress,
                      blockAddress: args.blockAddress,
                      blockNumber: blockNumber,
                      jobId,
                    },
                    null,
                    2
                  ),
                  task: "proveBlock",
                  metadata: `prove block ${args.blockNumber} (restart)`,
                  userId: this.cloud.userId,
                  maxAttempts: 20,
                });
              await this.cloud.deleteTask(this.cloud.taskId);
              console.timeEnd(`block ${args.blockNumber} validated`);

              return `Block ${blockNumber} is already validated`;
            }
          }
        }

        let previousValidBlockAddress = previousBlockAddress;
        let previousBlock = new BlockContract(
          previousValidBlockAddress,
          tokenId
        );
        await this.fetchMinaAccount({
          publicKey: previousBlockAddress,
          tokenId,
          force: true,
        });
        let previousBlockParams = BlockParams.unpack(
          previousBlock.blockParams.get()
        );
        isPreviousBlockFinal = previousBlockParams.isFinal.toBoolean();
        let found = false;
        while (found === false) {
          await this.getBlocksInfo({
            startBlock: previousValidBlockAddress,
            writeToAlgolia: true,
          });
          if (previousBlockParams.isInvalid.toBoolean() === false) found = true;
          else {
            previousValidBlockAddress = previousBlock.previousBlock.get();
            previousBlock = new BlockContract(
              previousValidBlockAddress,
              tokenId
            );

            await this.fetchMinaAccount({
              publicKey: previousValidBlockAddress,
              tokenId,
              force: true,
            });
            previousBlockParams = BlockParams.unpack(
              previousBlock.blockParams.get()
            );
          }
        }

        if (previousBlockParams.isValidated.toBoolean() === false) {
          console.log(`Previous block is not validated yet, waiting`);
          console.timeEnd(`block ${args.blockNumber} validated`);

          return `Previous block is not validated yet, waiting`;
        }

        const blockParams = BlockParams.unpack(block.blockParams.get());
        timeCreated = blockParams.timeCreated;

        const map = new MerkleMap();
        const blockStorage = block.storage.get();
        const hash = blockStorage.toIpfsHash();
        const json = await loadFromIPFS(hash);
        if (json.database === undefined)
          throw new Error("json.database is undefined");
        if (json.database.startsWith("i:") === false)
          throw new Error("json.database does not start with 'i:'");
        if (json.map === undefined) throw new Error("json.map is undefined");
        if (json.map.startsWith("i:") === false)
          throw new Error("json.map does not start with 'i:'");
        const databaseJson = await loadFromIPFS(json.database.substring(2));
        const mapJson = await loadFromIPFS(json.map.substring(2));

        /* validate json contents 
      blockNumber,
      timeCreated: time.toBigInt().toString(),
      contractAddress: contractAddress.toBase58(),
      blockAddress: blockPublicKey.toBase58(),
      root: root.toJSON(),
      blockProducer: blockProducer.publicKey.toBase58(),
      chainId: getNetworkIdHash().toJSON(),
      txsCount: txsCount.toBigint().toString(),
      txsHash: txsHash.toJSON(),
      previousBlockAddress: previousBlockAddress.toBase58(),
      previousValidBlockAddress: previousValidBlockAddress.toBase58(),
      oldRoot: oldRoot.toJSON(),
      transactions: elements.map((element) => {
        return {
          tx: element.serializedTx,
          fields: element.domainData?.toJSON(),
        };
      }),
      database: database.data,
      map: "i:" + mapHash,
      */
        if (timeCreated.toBigInt() !== BigInt(json.timeCreated))
          throw new Error(
            `Invalid timeCreated, ${timeCreated.toBigInt()} != ${
              json.timeCreated
            }`
          );
        if (contractAddress.toBase58() !== json.contractAddress)
          throw new Error("Invalid contractAddress");
        if (blockAddress.toBase58() !== json.blockAddress)
          throw new Error("Invalid blockAddress");
        if (block.root.get().toJSON() !== json.root)
          throw new Error("Invalid block root");
        if (getNetworkIdHash().toJSON() !== json.chainId)
          throw new Error("Invalid chainId");
        if (blockParams.txsCount.toBigint().toString() !== json.txsCount)
          throw new Error("Invalid txsCount");
        if (block.txsHash.get().toJSON() !== json.txsHash)
          throw new Error("Invalid txsHash");
        if (previousBlockAddress.toBase58() !== json.previousBlockAddress)
          throw new Error("Invalid previousBlockAddress");

        let database = new DomainDatabase();

        console.log("blockNumber", blockNumber);
        const oldMap = new MerkleMap();
        if (blockNumber > 1) {
          const previousBlockNumber = Number(
            previousBlock.blockNumber.get().toBigInt()
          );
          console.log(
            `getting previous block data for validation, block number: ${blockNumber} previous block: ${previousBlockNumber}`
          );
          const previousBlockStorage = previousBlock.storage.get();
          const previousBlockRoot = previousBlock.root.get();
          const previousBlockHash = previousBlockStorage.toIpfsHash();
          const previousBlockJson = await loadFromIPFS(previousBlockHash);
          //console.log("previousBlockJson map:", previousBlockJson.map);
          if (previousBlockJson.database === undefined)
            throw new Error("previousBlockJson.database is undefined");
          if (previousBlockJson.database.startsWith("i:") === false)
            throw new Error(
              "previousBlockJson.database does not start with 'i:'"
            );
          if (previousBlockJson.map === undefined)
            throw new Error("previousBlockJson.map is undefined");
          if (previousBlockJson.map.startsWith("i:") === false)
            throw new Error("previousBlockJson.map does not start with 'i:'");
          const previousBlockDatabaseJson = await loadFromIPFS(
            previousBlockJson.database.substring(2)
          );
          const previousBlockMapJson = await loadFromIPFS(
            previousBlockJson.map.substring(2)
          );
          database = new DomainDatabase(previousBlockDatabaseJson.database);
          //console.log("Previous Block Database", database.data);
          oldMap.tree = treeFromJSON(previousBlockMapJson.map);
          const oldRoot = oldMap.getRoot();
          if (previousBlockRoot.toJSON() !== oldRoot.toJSON())
            throw new Error("Invalid previous block root");
        }
        map.tree = treeFromJSON(mapJson.map);

        const elements: DomainCloudTransactionData[] = json.transactions.map(
          (element: any) => {
            return {
              serializedTx: element.tx,
              domainData:
                element.fields === undefined
                  ? undefined
                  : DomainTransactionData.fromJSON(element.fields),
            } as DomainCloudTransactionData;
          }
        );
        const root = block.root.get();
        if (root.toJSON() !== map.getRoot().toJSON())
          throw new Error("Invalid block root");

        const createdBlock = createBlock({
          elements,
          map: oldMap,
          time: timeCreated,
          database,
        });
        if (createdBlock === undefined)
          throw new Error("validateRollupBlock: createdBlock is undefined");

        const {
          root: calculatedRoot,
          txsHash: calculatedTxsHash,
          txsCount: calculatedTxsCount,
          proofData: calculatedProofData,
        } = createdBlock;

        proofData = calculatedProofData;
        const storage = block.storage.get();
        const txsHash = block.txsHash.get();

        if (calculatedRoot.toJSON() !== root.toJSON())
          throw new Error("Invalid block root");
        if (calculatedTxsHash.toJSON() !== txsHash.toJSON())
          throw new Error("Invalid block transactions");
        if (calculatedTxsCount.toBigint() !== blockParams.txsCount.toBigint())
          throw new Error("Invalid block transactions count");
        const loadedDatabase = new DomainDatabase(databaseJson.database);
        assert.deepStrictEqual(database.data, loadedDatabase.data);
        if (root.toJSON() !== database.getRoot().toJSON())
          throw new Error("Invalid block root");
        if (root.toJSON() !== loadedDatabase.getRoot().toJSON())
          throw new Error("Invalid block root");
        //console.log(`Block ${blockNumber} is valid`);

        if (onlyRestartProving === true) {
          const jobId = await this.cloud.recursiveProof({
            transactions: proofData,
            task: "proofMap",
            metadata: `block ${blockNumber} proof creation (restart)`,
            userId: this.cloud.userId,
            args: JSON.stringify({
              timeCreated: timeCreated.toJSON(),
              proofsOff,
            }),
          });
          await this.cloud.saveDataByKey(
            `proofMap.${blockNumber}.jobId`,
            jobId
          );

          await this.cloud.addTask({
            args: JSON.stringify(
              {
                contractAddress: args.contractAddress,
                blockAddress: args.blockAddress,
                blockNumber: blockNumber,
                jobId,
              },
              null,
              2
            ),
            task: "proveBlock",
            metadata: `prove block ${blockNumber} (restart)`,
            userId: this.cloud.userId,
            maxAttempts: 20,
          });
          await this.cloud.deleteTask(this.cloud.taskId);
          console.timeEnd(`block ${blockNumber} validated`);

          return `Block ${blockNumber} is already validated`;
        }

        await this.compile();
        if (
          RollupWorker.mapUpdateVerificationKey === undefined ||
          RollupWorker.blockContractVerificationKey === undefined ||
          RollupWorker.validatorsVerificationKey === undefined ||
          RollupWorker.contractVerificationKey === undefined
        )
          throw new Error("verificationKey is undefined");

        decision = new ValidatorsDecision({
          contractAddress,
          chainId: getNetworkIdHash(),
          validators,
          decisionType: ValidatorDecisionType.validate,
          data: BlockValidationData.toFields({
            storage,
            root,
            txsHash,
            txsCount: calculatedTxsCount,
            blockAddress,
            notUsed: Field(0),
          }),
          expiry: UInt64.from(Date.now() + 1000 * 60 * 60 * 24 * 2000),
        });
      } catch (error) {
        console.error("Error in validateBlock", error);
        if (isPreviousBlockFinal === false) {
          console.error(
            `Block ${args.blockNumber} is bad and previous block is not final`
          );
          console.timeEnd(`block ${args.blockNumber} validated`);

          return `Block ${args.blockNumber} is bad and previous block is not final`;
        }
        validated = false;

        decision = new ValidatorsDecision({
          contractAddress,
          chainId: getNetworkIdHash(),
          validators,
          decisionType: ValidatorDecisionType.badBlock,
          data: BadBlockValidationData.toFields({
            blockAddress,
            notUsed: [
              Field(0),
              Field(0),
              Field(0),
              Field(0),
              Field(0),
              Field(0),
            ],
          }),
          expiry: UInt64.from(Date.now() + 1000 * 60 * 60),
        });
        await this.compile();
        if (
          RollupWorker.mapUpdateVerificationKey === undefined ||
          RollupWorker.blockContractVerificationKey === undefined ||
          RollupWorker.validatorsVerificationKey === undefined ||
          RollupWorker.contractVerificationKey === undefined
        )
          throw new Error("verificationKey is undefined");
      }

      if (decision === undefined) throw new Error("decision is undefined");

      const proof: ValidatorsVotingProof = await calculateValidatorsProof(
        decision,
        RollupWorker.validatorsVerificationKey,
        false
      );

      if (proof.publicInput.hash.toJSON() !== validators.hash.toJSON())
        throw new Error("Invalid validators hash in proof");

      const deployerKeyPair = await this.cloud.getDeployer();
      if (deployerKeyPair === undefined)
        throw new Error("deployer is undefined");
      const deployer = PrivateKey.fromBase58(deployerKeyPair.privateKey);
      const sender = deployer.toPublicKey();
      if (previousBlockAddress !== undefined)
        await this.fetchMinaAccount({
          publicKey: previousBlockAddress,
          tokenId,
          force: true,
        });
      else
        console.error("validateRollupBlock: previousBlockAddress is undefined");

      await this.fetchMinaAccount({ publicKey: sender, force: true });
      await this.fetchMinaAccount({
        publicKey: contractAddress,
        force: true,
      });
      await this.fetchMinaAccount({
        publicKey: blockAddress,
        tokenId,
        force: true,
      });

      console.log(
        `Sending validation tx for block ${blockNumber}, validation result: ${
          validated ? "validated" : "bad block"
        }`
      );
      if (validated === false) console.error(`Block ${blockNumber} is invalid`);

      const tx = await Mina.transaction(
        {
          sender,
          fee: await fee(),
          memo: validated
            ? `MinaNFT: block ${blockNumber} is valid`
            : `MinaNFT: bad block ${blockNumber}`,
        },
        async () => {
          validated
            ? await zkApp.validateBlock(proof)
            : await zkApp.badBlock(proof);
        }
      );

      await this.prove(tx);
      const txSent = await tx.sign([deployer]).safeSend();
      if (txSent.errors.length > 0) {
        console.error(
          `validate block tx error: hash: ${txSent.hash} status: ${txSent.status}  errors: ${txSent.errors}`
        );
      } else
        console.log(
          `validate block tx sent: hash: ${txSent.hash} status: ${txSent.status}`
        );
      if (txSent.status !== "pending") {
        await this.cloud.releaseDeployer({
          publicKey: deployerKeyPair.publicKey,
          txsHashes: [],
        });
        throw new Error("Error sending block creation transaction");
      }
      await this.cloud.releaseDeployer({
        publicKey: deployerKeyPair.publicKey,
        txsHashes: [txSent.hash],
      });
      //console.log("Deleting validateBlock task", this.cloud.taskId);
      await this.cloud.deleteTask(this.cloud.taskId);
      if (validated) {
        const jobId = await this.cloud.recursiveProof({
          transactions: proofData,
          task: "proofMap",
          metadata: `block ${args.blockNumber} proof creation`,
          userId: this.cloud.userId,
          args: JSON.stringify({ timeCreated: timeCreated.toJSON() }),
        });
        await this.cloud.saveDataByKey(
          `proofMap.${args.blockNumber}.jobId`,
          jobId
        );
        await this.cloud.addTask({
          args: JSON.stringify(
            {
              contractAddress: args.contractAddress,
              blockAddress: args.blockAddress,
              blockNumber: args.blockNumber,
              txHash: txSent.hash,
              jobId,
            },
            null,
            2
          ),
          task: "proveBlock",
          metadata: `prove block ${args.blockNumber}`,
          userId: this.cloud.userId,
          maxAttempts: 20,
        });
      }
      console.timeEnd(`block ${args.blockNumber} validated`);
      if (this.cloud.isLocalCloud === true) {
        if (this.cloud.chain !== "zeko") {
          const txIncluded = await txSent.safeWait();
          console.log(
            `validate block ${blockNumber} tx included into block: hash: ${txIncluded.hash} status: ${txIncluded.status}`
          );
        }
        await sleep(20000);
      }

      return txSent.hash;
    } catch (error) {
      console.error("Error in validateRollupBlock", error);

      return "Error in validateRollupBlock";
    }
  }

  public static async deserializeTransaction(
    tx: DomainSerializedTransaction,
    signatureRequired = true
  ): Promise<{
    tx?: DomainTransaction;
    oldDomain?: RollupNftName;
    status: DomainCloudTransactionStatus;
    reason?: string;
  }> {
    console.log("deserializeTransaction", tx);
    try {
      const operationType =
        tx.operation === "add"
          ? DomainTransactionEnum.add
          : tx.operation === "extend"
          ? DomainTransactionEnum.extend
          : tx.operation === "update"
          ? DomainTransactionEnum.update
          : tx.operation === "remove"
          ? DomainTransactionEnum.remove
          : undefined;
      if (operationType === undefined) {
        console.error("Invalid operation type:", tx.operation);
        return {
          status: "invalid",
          reason: "Invalid operation type",
        };
      }
      let metadata: Metadata;
      let storage: Storage;
      if (tx.operation === "update") {
        if (
          tx.signature === undefined ||
          tx.storage === undefined ||
          tx.metadata === undefined
        ) {
          if (signatureRequired)
            return {
              status: "invalid",
              reason: "signature, metadata or storage is undefined",
            };
          //console.log("creating update NFT", tx);
          const nft: RollupNFTData = await createRollupNFT(tx);
          metadata = nft.metadataRoot;
          storage = nft.storage;
        } else {
          //console.log("deserializing update NFT", tx);
          metadata = Metadata.fromFields(
            deserializeFields(tx.metadata)
          ) as Metadata;
          storage = Storage.fromFields(
            deserializeFields(tx.storage)
          ) as Storage;
        }
      } else {
        if (tx.metadata === undefined || tx.storage === undefined) {
          const nft: RollupNFTData = await createRollupNFT(tx);
          metadata = nft.metadataRoot;
          storage = nft.storage;
        } else {
          metadata = Metadata.fromFields(
            deserializeFields(tx.metadata)
          ) as Metadata;
          storage = Storage.fromFields(
            deserializeFields(tx.storage)
          ) as Storage;
        }
      }
      if (metadata === undefined || storage === undefined)
        throw new Error("metadata or storage is undefined");

      const name = stringToFields(tx.name);
      if (name.length !== 1) throw new Error("Invalid name length");
      const domainName: RollupNftName = new RollupNftName({
        name: name[0],
        data: new RollupNftNameValue({
          address: PublicKey.fromBase58(tx.address),
          metadata,
          storage,
          expiry: UInt64.from(tx.expiry),
        }),
      });
      let oldDomain: RollupNftName | undefined = undefined;
      if (tx.oldDomain !== undefined) {
        oldDomain = RollupNftName.fromFields(
          deserializeFields(tx.oldDomain)
        ) as RollupNftName;
      }

      const domainTransaction: DomainTransaction = new DomainTransaction({
        type: operationType,
        domain: domainName,
      }) as DomainTransaction;

      return {
        status: "pending",
        tx: domainTransaction,
        oldDomain,
      };
    } catch (error: any) {
      console.error("Error in convertTransaction", error, "tx:", tx);
      return {
        status: "invalid",
        reason: error.message,
      };
    }
  }

  private async prepareSignTransactionData(): Promise<string> {
    try {
      if (this.cloud.args === undefined) return "error";
      const args = JSON.parse(this.cloud.args);
      if (args.contractAddress === undefined)
        return "error: contractAddress is undefined";
      const contractAddress = PublicKey.fromBase58(args.contractAddress);
      if (contractAddress === undefined) {
        console.error(
          "prepareSignTransactionData: contractAddress is undefined"
        );
        return "error: contractAddress is undefined";
      }
      if (contractAddress.toBase58() !== nameContract.contractAddress) {
        console.error("prepareSignTransactionData: contractAddress is invalid");
        return "error: contractAddress is invalid";
      }
      if (args.tx === undefined) {
        console.error("prepareSignTransactionData: tx is undefined");
        return "error: tx is undefined";
      }
      const tx = args.tx as DomainSerializedTransaction;
      console.log("prepareSignTransactionData", tx);
      const deserializedTransaction = await RollupWorker.deserializeTransaction(
        tx,
        false
      );
      if (
        deserializedTransaction.status !== "pending" ||
        deserializedTransaction.tx === undefined
      ) {
        console.error(
          "Error in deserializing transaction:",
          deserializedTransaction
        );
        return (
          "error:" + deserializedTransaction.reason ??
          "error in deserializing transaction"
        );
      }

      const signatureData = DomainTransaction.toFields(
        deserializedTransaction.tx
      ).map((field) => field.toJSON());
      tx.signature = JSON.stringify({ signatureData });
      tx.metadata = serializeFields(
        Metadata.toFields(deserializedTransaction.tx.domain.data.metadata)
      );
      tx.storage = serializeFields(
        Storage.toFields(deserializedTransaction.tx.domain.data.storage)
      );
      tx.newDomain = serializeFields(
        RollupNftName.toFields(deserializedTransaction.tx.domain)
      );
      console.log("prepareSignTransactionData result", tx);
      return JSON.stringify(tx);
    } catch (error: any) {
      console.error("Error in prepareSignTransactionData", error);
      let msg: string = "error in prepareSignTransactionData";
      if (error.message !== undefined && typeof error.message === "string")
        msg = error.message;
      return "error:" + msg;
    }
  }

  private async convertTransaction(
    txInput: CloudTransaction
  ): Promise<DomainCloudTransactionData> {
    try {
      const txParsed: DomainSerializedTransaction = JSON.parse(
        txInput.transaction
      ) as DomainSerializedTransaction;
      const tx = await RollupWorker.deserializeTransaction(txParsed);
      if (tx.status !== "pending" || tx.tx === undefined) {
        return {
          serializedTx: {
            txId: txInput.txId,
            transaction: txInput.transaction,
            timeReceived: txInput.timeReceived,
            status: tx.status,
            reason: tx.reason,
          } as DomainCloudTransaction,
          domainData: undefined,
        };
      }

      const domainTransactionData: DomainTransactionData =
        new DomainTransactionData(
          tx.tx,
          tx.oldDomain,
          txParsed.signature === undefined
            ? undefined
            : Signature.fromBase58(txParsed.signature)
        );
      return {
        serializedTx: {
          txId: txInput.txId,
          transaction: txInput.transaction,
          timeReceived: txInput.timeReceived,
          status: "pending",
        } as DomainCloudTransaction,
        domainData: domainTransactionData,
      };
    } catch (error: any) {
      console.error("Error in convertTransaction", error, "tx:", txInput);
      return {
        serializedTx: {
          txId: txInput.txId,
          transaction: txInput.transaction,
          timeReceived: txInput.timeReceived,
          status: "invalid",
          reason: error.message,
        } as DomainCloudTransaction,
        domainData: undefined,
      };
    }
  }

  private async createRollupBlock(
    txs: CloudTransaction[]
  ): Promise<string | undefined> {
    try {
      if (this.cloud.args === undefined)
        throw new Error("this.cloud.args is undefined");
      const args = JSON.parse(this.cloud.args);
      console.log("args", args);
      if (args.contractAddress === undefined)
        throw new Error("args.contractAddress is undefined");
      if (args.contractAddress !== nameContract.contractAddress) {
        console.error("createRollupBlock: contractAddress is invalid");
        return "contractAddress is invalid";
      }

      const blockPrivateKey = PrivateKey.random();
      const blockPublicKey = blockPrivateKey.toPublicKey();
      const contractAddress = PublicKey.fromBase58(args.contractAddress);
      const zkApp = new RollupContract(contractAddress);
      const tokenId = zkApp.deriveTokenId();
      await this.fetchMinaAccount({ publicKey: contractAddress, force: true });
      const validators = getValidators(0).validators;
      const validatorsPacked = zkApp.validatorsPacked.get();
      if (validators.pack().toJSON() !== validatorsPacked.toJSON())
        throw new Error("Invalid validatorsPacked");
      const previousBlockAddress = LastBlock.unpack(
        zkApp.lastCreatedBlock.get()
      ).address;
      let previousValidBlockAddress = previousBlockAddress;
      console.log("previousBlockAddress", previousBlockAddress.toBase58());

      const previousBlockAddressVar = await this.cloud.getDataByKey(
        "lastBlockAddress"
      );
      if (previousBlockAddressVar !== undefined) {
        const { address, timeStarted } = JSON.parse(previousBlockAddressVar);
        if (address !== undefined && timeStarted !== undefined) {
          if (
            address !== previousBlockAddress.toBase58() &&
            timeStarted > Date.now() - 1000 * 60 * 20
          ) {
            console.log(
              "lastBlockAddress is not equal to previousBlockAddress, waiting.."
            );

            return "lastBlockAddress is not equal to previousBlockAddress";
          }
          if (timeStarted > Date.now() - this.MIN_TIME_BETWEEN_BLOCKS) {
            console.log("Not enough time between blocks:", {
              lastBlockTme: new Date(timeStarted).toLocaleString(),
              now: new Date().toLocaleString(),
            });

            return "Not enough time between blocks";
          }
        }
      }

      let previousBlock = new BlockContract(previousValidBlockAddress, tokenId);
      await this.fetchMinaAccount({
        publicKey: previousValidBlockAddress,
        tokenId,
        force: true,
      });
      const blockNumber =
        Number(previousBlock.blockNumber.get().toBigInt()) + 1;
      let previousValidBlockParams = BlockParams.unpack(
        previousBlock.blockParams.get()
      );
      if (
        previousValidBlockParams.isFinal.toBoolean() === false &&
        previousValidBlockParams.isValidated.toBoolean() === false
      ) {
        console.log(`Previous block is not final and not validated`);

        return "Previous block is not final and not validated";
      }
      const previousBlockTimeCreated = Number(
        previousValidBlockParams.timeCreated.toBigInt()
      );

      await this.getBlocksInfo({
        startBlock: previousValidBlockAddress,
        writeToAlgolia: true,
      });

      if (
        txs.length < this.MIN_TRANSACTIONS &&
        Date.now() - previousBlockTimeCreated < this.MAX_TIME_BETWEEN_BLOCKS
      ) {
        console.log("Not enough transactions to create a block:", txs.length);

        return "Not enough transactions to create a block";
      }

      console.time(`block created`);
      console.time("block calculated");

      await this.cloud.saveDataByKey(
        "lastBlockAddress",
        JSON.stringify(
          { address: blockPublicKey.toBase58(), timeStarted: Date.now() },
          null,
          2
        )
      );

      let found = false;
      while (found === false) {
        if (previousValidBlockParams.isInvalid.toBoolean() === false)
          found = true;
        else {
          previousValidBlockAddress = previousBlock.previousBlock.get();
          previousBlock = new BlockContract(previousValidBlockAddress, tokenId);
          await this.fetchMinaAccount({
            publicKey: previousValidBlockAddress,
            tokenId,
            force: true,
          });
          previousValidBlockParams = BlockParams.unpack(
            previousBlock.blockParams.get()
          );
        }
      }
      const previousValidBlockNumber = Number(
        previousBlock.blockNumber.get().toBigInt()
      );
      const blockNames: string[] = [];
      for (let i = 0; i < txs.length; i++) {
        let name = "invalid";
        try {
          name = JSON.parse(txs[i].transaction).name;
        } catch (error) {
          console.error("Error parsing tx", error, txs[i]);
        }
        blockNames.push(name);
      }
      console.log(
        `Creating block ${blockNumber}, last valid block: ${previousValidBlockNumber}`,
        blockNames
      );

      let database: DomainDatabase = new DomainDatabase();
      let map = new MerkleMap();
      const previousBlockRoot = previousBlock.root.get();
      if (blockNumber > 1) {
        const storage = previousBlock.storage.get();
        const hash = storage.toIpfsHash();
        const json = await loadFromIPFS(hash);
        if (json.database === undefined)
          throw new Error("json.database is undefined");
        if (json.database.startsWith("i:") === false)
          throw new Error("json.database does not start with 'i:'");
        if (json.map === undefined) throw new Error("json.map is undefined");
        if (json.map.startsWith("i:") === false)
          throw new Error("json.map does not start with 'i:'");
        const databaseJson = await loadFromIPFS(json.database.substring(2));
        const mapJson = await loadFromIPFS(json.map.substring(2));
        map.tree = treeFromJSON(mapJson.map);
        database = new DomainDatabase(databaseJson.database);
        let deletedCount = 0;
        let deletedNames: string[] = [];
        let notFoundNames: string[] = [];
        console.log(
          `Deleting ${json.transactions.length} transactions from previous block...`
        );
        for (let i = 0; i < json.transactions.length; i++) {
          const element = json.transactions[i];
          //console.log("Deleting tx", element);
          const tx: DomainCloudTransaction =
            element.tx as DomainCloudTransaction;

          deletedCount++;
          let name = "invalid";
          try {
            name = JSON.parse(tx.transaction).name;
          } catch (error) {
            console.error("Error parsing tx", error, tx);
          }
          deletedNames.push(name);
          try {
            await this.cloud.deleteTransaction(tx.txId);
          } catch (error) {
            console.log("Transaction already deleted:", name);
          }
          // find and delete this tx from txs
          const index = txs.findIndex(
            (transaction) => transaction.txId === tx.txId
          );
          if (index === -1) {
            console.log("Cannot find tx to delete", name);
            notFoundNames.push(name);
          } else txs.splice(index, 1);
        }
        console.log(
          `Deleted ${deletedCount} transactions from previous block:`,
          deletedNames
        );
        if (notFoundNames.length > 0)
          console.log(
            `Not found ${notFoundNames.length} names:`,
            notFoundNames
          );
      }

      const elements: DomainCloudTransactionData[] = [];
      let count = 0;
      let approvedNames: string[] = [];
      let rejectedNames: string[] = [];
      for (let i = 0; i < txs.length; i++) {
        if (count >= this.MAX_TRANSACTIONS) break;
        try {
          const element = await this.convertTransaction(txs[i]);
          if (element.domainData !== undefined) {
            count++;
            approvedNames.push(
              stringFromFields([element.domainData.tx.domain.name])
            );
          } else {
            let name = "invalid";
            try {
              name = JSON.parse(txs[i].transaction).name;
            } catch (error) {
              console.error("Error parsing tx", error, txs[i]);
            }
            rejectedNames.push(name);
          }
          elements.push(element);
        } catch (error) {
          console.error("Error in convertTransaction: catch:", error);
        }
      }

      console.log("Approved names:", approvedNames);
      console.log("Rejected names:", rejectedNames);
      console.log("Elements count:", count, elements.length);

      if (
        count === 0 ||
        (count < this.MIN_TRANSACTIONS &&
          Date.now() - previousBlockTimeCreated < this.MAX_TIME_BETWEEN_BLOCKS)
      ) {
        console.log("Not enough transactions to create a block:", count);
        await this.cloud.saveDataByKey("lastBlockAddress", undefined);

        console.timeEnd("block calculated");
        console.timeEnd("block created");
        return "Not enough transactions to create a block";
      }
      console.log(
        `Creating block with ${count} transactions of ${txs.length} transactions...`
      );
      //console.log("transactions", transactions);
      //console.log("this.cloud", this.cloud);

      if (fullValidation) {
        console.time("full validation");
        if (
          database.getRoot().toJSON() !== previousBlockRoot.toJSON() ||
          map.getRoot().toJSON() !== previousBlockRoot.toJSON()
        ) {
          console.timeEnd("full validation");
          throw new Error("Invalid previous block");
        }
        console.timeEnd("full validation");
      }
      const time = UInt64.from(Date.now());
      const createdBlock = createBlock({
        elements,
        map,
        time,
        database,
      });
      if (createdBlock === undefined)
        throw new Error("createRollupBlock: createdBlock is undefined");

      const { root, oldRoot, txsHash, txsCount, invalidTxsCount } =
        createdBlock;

      if (count !== Number(txsCount.toBigint())) {
        console.error("Invalid txsCount", {
          count,
          txsCount: txsCount.toBigint().toString(),
        });
      }

      const mapJson = {
        map: treeToJSON(map.tree),
      };
      if (fullValidation) {
        console.time("full validation");
        const restoredMap = new MerkleMap();
        restoredMap.tree = treeFromJSON(mapJson.map);

        if (restoredMap.getRoot().toJSON() !== root.toJSON()) {
          console.timeEnd("full validation");
          throw new Error("Invalid root");
        }
        console.timeEnd("full validation");
      }

      console.time("map saved to IPFS");
      const mapHash = await saveToIPFS({
        data: mapJson,
        pinataJWT: process.env.PINATA_JWT!,
        name: `block.${blockNumber}.map.${contractAddress.toBase58()}.json`,
        keyvalues: {
          blockNumber: blockNumber.toString(),
          type: "Merkle Map",
          contractAddress: contractAddress.toBase58(),
          repo: this.cloud.repo,
          developer: this.cloud.developer,
          id: this.cloud.id,
          userId: this.cloud.userId,
          chain: this.cloud.chain,
          networkId: getNetworkIdHash().toJSON(),
        },
      });
      console.timeEnd("map saved to IPFS");
      if (mapHash === undefined) throw new Error("mapHash is undefined");
      console.time("database saved to IPFS");
      const databaseJson = {
        database: database.data,
        map: "i:" + mapHash,
      };
      const databaseHash = await saveToIPFS({
        data: databaseJson,
        pinataJWT: process.env.PINATA_JWT!,
        name: `block.${blockNumber}.database.${contractAddress.toBase58()}.json`,
        keyvalues: {
          blockNumber: blockNumber.toString(),
          type: "block database",
          contractAddress: contractAddress.toBase58(),
          repo: this.cloud.repo,
          developer: this.cloud.developer,
          id: this.cloud.id,
          userId: this.cloud.userId,
          chain: this.cloud.chain,
          networkId: getNetworkIdHash().toJSON(),
        },
      });
      console.timeEnd("database saved to IPFS");
      if (databaseHash === undefined)
        throw new Error("Database hash is undefined");
      const json = {
        blockNumber,
        timeCreated: time.toBigInt().toString(),
        contractAddress: contractAddress.toBase58(),
        blockAddress: blockPublicKey.toBase58(),
        root: root.toJSON(),
        blockProducer: blockProducer.publicKey.toBase58(),
        chainId: getNetworkIdHash().toJSON(),
        txsCount: txsCount.toBigint().toString(),
        invalidTxsCount: invalidTxsCount,
        txsHash: txsHash.toJSON(),
        previousBlockAddress: previousBlockAddress.toBase58(),
        previousValidBlockAddress: previousValidBlockAddress.toBase58(),
        oldRoot: oldRoot.toJSON(),
        transactions: elements.map((element) => {
          return {
            name: element.domainData?.tx?.domain?.name
              ? stringFromFields([element.domainData.tx.domain.name])
              : undefined,
            newDomain: element.domainData?.tx?.domain
              ? serializeFields(
                  RollupNftName.toFields(element.domainData.tx.domain)
                )
              : undefined,
            tx: element.serializedTx,
            fields: element.domainData?.toJSON(),
          };
        }),
        database: "i:" + databaseHash,
        map: "i:" + mapHash,
      };
      const hash = await saveToIPFS({
        data: json,
        pinataJWT: process.env.PINATA_JWT!,
        name: `block.${blockNumber}.${contractAddress.toBase58()}.json`,
        keyvalues: {
          blockNumber: blockNumber.toString(),
          type: "block data",
          contractAddress: contractAddress.toBase58(),
          repo: this.cloud.repo,
          developer: this.cloud.developer,
          id: this.cloud.id,
          userId: this.cloud.userId,
          chain: this.cloud.chain,
          networkId: getNetworkIdHash().toJSON(),
        },
      });
      if (hash === undefined) throw new Error("hash is undefined");

      console.log(`Block ${blockNumber} created:`, {
        hash: "https://gateway.pinata.cloud/ipfs/" + hash,
        databaseHash: "https://gateway.pinata.cloud/ipfs/" + databaseHash,
        mapHash: "https://gateway.pinata.cloud/ipfs/" + mapHash,
      });

      const block = {
        blockNumber: json.blockNumber,
        blockAddress: json.blockAddress,
        root: json.root,
        ipfs: hash,
        isValidated: false,
        isInvalid: false,
        isProved: false,
        isFinal: false,
        timeCreated: json.timeCreated,
        txsCount: json.txsCount,
        txsHash: json.txsHash,
        previousBlockAddress: json.previousBlockAddress,
      };

      await algoliaWriteBlock({
        block,
        contractAddress: contractAddress.toBase58(),
        chain: this.cloud.chain,
        txs: json.transactions.map((tx) => tx.tx),
      });

      const blockStorage = Storage.fromIpfsHash(hash);
      if (
        blockProducer.privateKey.toPublicKey().toBase58() !==
        blockProducer.publicKey.toBase58()
      )
        throw new Error("blockProducer keys mismatch");

      console.timeEnd("block calculated");
      await this.compile();

      if (
        RollupWorker.mapUpdateVerificationKey === undefined ||
        RollupWorker.blockContractVerificationKey === undefined ||
        RollupWorker.validatorsVerificationKey === undefined ||
        RollupWorker.contractVerificationKey === undefined
      )
        throw new Error("verificationKey is undefined");
      const blockVerificationKey: VerificationKey =
        RollupWorker.blockContractVerificationKey;
      const validatorsVerificationKey: VerificationKey =
        RollupWorker.validatorsVerificationKey;

      console.time("validators proof");

      const decision = new ValidatorsDecision({
        contractAddress,
        chainId: getNetworkIdHash(),
        validators,
        decisionType: ValidatorDecisionType.createBlock,
        data: BlockCreationData.toFields({
          oldRoot,
          blockAddress: blockPublicKey,
          blockProducer: blockProducer.publicKey,
          previousBlockAddress,
          verificationKeyHash: RollupWorker.blockContractVerificationKey.hash,
        }),
        expiry: UInt64.from(Date.now() + 1000 * 60 * 60 * 24 * 2000),
      });
      const proof: ValidatorsVotingProof = await calculateValidatorsProof(
        decision,
        validatorsVerificationKey,
        false
      );
      if (proof.publicInput.hash.toJSON() !== validators.hash.toJSON())
        throw new Error("Invalid validatorsHash");
      const ok = await verify(proof, validatorsVerificationKey);
      if (!ok) throw new Error("proof verification failed");
      console.log("validators proof verified:", ok);
      console.timeEnd("validators proof");

      console.time("prepared tx");
      const blockData: BlockData = new BlockData({
        blockAddress: blockPublicKey,
        root,
        storage: blockStorage,
        txsHash,
        blockNumber: UInt64.from(blockNumber),
        blockParams: new BlockParams({
          txsCount,
          timeCreated: time,
          isFinal: Bool(false),
          isProved: Bool(false),
          isInvalid: Bool(false),
          isValidated: Bool(false),
        }).pack(),
        previousBlockAddress: previousBlockAddress,
      });

      await this.fetchMinaAccount({
        publicKey: blockProducer.publicKey,
        force: true,
      });
      const blockProducerBalance = await accountBalanceMina(
        blockProducer.publicKey
      );
      console.log("Block producer balance:", blockProducerBalance);
      if (blockProducerBalance < 20) {
        console.error("Block producer balance is less than 20 MINA");
      }

      if (blockProducerBalance < 10) {
        console.log(
          "Block producer balance is less than 10 MINA, replenishing..."
        );
        const deployerKeyPair = await this.cloud.getDeployer();
        if (deployerKeyPair === undefined)
          throw new Error("deployer is undefined");
        const deployer = PrivateKey.fromBase58(deployerKeyPair.privateKey);
        if (deployer !== undefined) {
          const deployerPublicKey = deployer.toPublicKey();
          const transaction = await Mina.transaction(
            {
              sender: deployerPublicKey,
              fee: "100000000",
              memo: "MinaNFT: payment",
            },
            async () => {
              const senderUpdate =
                AccountUpdate.createSigned(deployerPublicKey);
              senderUpdate.send({
                to: blockProducer.publicKey,
                amount: 25_000_000_000,
              });
            }
          );
          const txSent = await transaction.sign([deployer]).safeSend();
          console.log("Replenishing block producer balance tx sent:", {
            status: txSent.status,
            hash: txSent.hash,
          });
        }
      }

      console.log(`Sending tx for block ${blockNumber}...`);
      const memo =
        `MinaNFT: block ${blockNumber} created: ${count} txs`.substring(0, 30);
      await this.fetchMinaAccount({
        publicKey: contractAddress,
        force: true,
      });
      await this.fetchMinaAccount({
        publicKey: blockProducer.publicKey,
        force: true,
      });
      await this.fetchMinaAccount({
        publicKey: previousBlockAddress,
        tokenId,
        force: true,
      });
      const tx = await Mina.transaction(
        { sender: blockProducer.publicKey, fee: await fee(), memo },
        async () => {
          AccountUpdate.fundNewAccount(blockProducer.publicKey);
          await zkApp.block(proof, blockData, blockVerificationKey); //signature,
        }
      );

      tx.sign([blockProducer.privateKey, blockPrivateKey]);
      try {
        await this.prove(tx);
        console.timeEnd("prepared tx");
        const txSent = await tx.safeSend();
        console.log(
          `Block ${blockNumber} sent with hash ${txSent.hash} and status ${txSent.status}`
        );
        if (txSent.status !== "pending") {
          console.error("Error sending block creation transaction");
          console.timeEnd(`block created`);

          return "Error sending block creation transaction";
        }
        if (this.cloud.isLocalCloud === true) {
          if (this.cloud.chain !== "zeko") {
            const txIncluded = await txSent.safeWait();
            console.log(
              `create block ${blockNumber} tx included into block: hash: ${txIncluded.hash} status: ${txIncluded.status}`
            );
          }
          await sleep(20000);
        }

        await algoliaWriteBlock({
          block: { txId: txSent.hash, ...block },
          contractAddress: contractAddress.toBase58(),
          chain: this.cloud.chain,
        });
        await this.cloud.addTask({
          args: JSON.stringify(
            {
              contractAddress: args.contractAddress,
              blockAddress: blockPublicKey.toBase58(),
              txHash: txSent.hash,
              blockNumber,
            },
            null,
            2
          ),
          task: "validateBlock",
          metadata: `block ${blockNumber} validation`,
          userId: this.cloud.userId,
          maxAttempts: 50,
        });

        console.timeEnd(`block created`);

        return txSent.hash;
      } catch (error) {
        console.error("Error sending block creation transaction", error);
        console.timeEnd(`block created`);

        return "Error sending block creation transaction";
      }
    } catch (error: any) {
      console.error("Error in createRollupBlock", error);

      return "Error in createRollupBlock";
    }
  }

  async fetchMinaAccount(params: {
    publicKey: string | PublicKey;
    tokenId?: string | Field | undefined;
    force?: boolean;
  }) {
    const { publicKey, tokenId, force } = params;
    const timeout = 1000 * 60 * 2; // 2 minutes
    const startTime = Date.now();
    let result = { account: undefined };
    while (Date.now() - startTime < timeout) {
      try {
        const result = await fetchAccount({
          publicKey,
          tokenId,
        });
        return result;
      } catch (error: any) {
        if (force === true)
          console.log("Error in fetchMinaAccount:", {
            error,
            publicKey:
              typeof publicKey === "string" ? publicKey : publicKey.toBase58(),
            tokenId: tokenId?.toString(),
            force,
          });
        else {
          console.log("fetchMinaAccount error", {
            error,
            publicKey:
              typeof publicKey === "string" ? publicKey : publicKey.toBase58(),
            tokenId: tokenId?.toString(),
            force,
          });
          return result;
        }
      }
      await sleep(1000 * 5);
    }
    if (force === true)
      throw new Error(
        `fetchMinaAccount timeout
        ${{
          publicKey:
            typeof publicKey === "string" ? publicKey : publicKey.toBase58(),
          tokenId: tokenId?.toString(),
          force,
        }}`
      );
    else
      console.log(
        "fetchMinaAccount timeout",
        typeof publicKey === "string" ? publicKey : publicKey.toBase58(),
        tokenId?.toString(),
        force
      );
    return result;
  }

  private async prove(tx: Mina.Transaction<false, false>) {
    try {
      await tx.prove();
      return tx;
    } catch (error) {
      console.error("Error in prove", error);
      await this.cloud.forceWorkerRestart();
      throw new Error("Error in prove");
    }
  }
}
