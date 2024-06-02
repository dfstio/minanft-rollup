import algoliasearch from "algoliasearch";
import { deserializeFields } from "minanft";
import { ALGOLIA_KEY, ALGOLIA_PROJECT } from "../../env.json";
import { Storage } from "../contract/storage";
import { Metadata } from "../contract/metadata";
import { stringToFields, stringFromFields } from "../lib/hash";
import {
  BlockJson,
  TransactionJson,
  calculateBlockHash,
  TransactionJsonFields,
  BlockJsonFields,
  BlockTransaction,
} from "./types";
import {
  DomainCloudTransaction,
  DomainSerializedTransaction,
  DomainTransactionData,
} from "../rollup/transaction";

export async function algoliaWriteBlock(params: {
  contractAddress: string;
  chain: string;
  block?: BlockJson;
  txs?: BlockTransaction[];
}): Promise<{ success: boolean; blockHash: string | undefined }> {
  const { contractAddress, chain, block, txs } = params;
  const blockHash = block ? calculateBlockHash(block) : undefined;
  console.log("alWriteBlock", { contractAddress, chain, blockHash });
  try {
    const client = algoliasearch(ALGOLIA_PROJECT, ALGOLIA_KEY);

    if (block) {
      for (const field of BlockJsonFields.values) {
        if (
          field.optional !== true &&
          (block as any)[field.name] === undefined
        ) {
          console.error(`Block field ${field.name} is undefined`);
          return { success: false, blockHash };
        }
      }

      const rollupBlocks = client.initIndex("rollup-blocks");
      const result = await rollupBlocks.saveObject({
        objectID: blockHash,
        blockHash,
        ...block,
      });

      if (result.taskID === undefined)
        console.error(
          "Algolia write result for block",
          block.blockNumber,
          "is ",
          result
        );
    }

    if (!txs) return { success: true, blockHash };
    const rollupTransactions = client.initIndex("rollup-txs");
    for (const item of txs) {
      console.log("alWriteBlock tx", item);
      const transaction: DomainTransactionData | undefined = item.fields
        ? (DomainTransactionData.fromJSON(item.fields) as DomainTransactionData)
        : undefined;
      const metadata: Metadata | undefined = transaction?.tx.domain.data
        .metadata
        ? transaction?.tx.domain.data.metadata
        : undefined;
      const storage: Storage | undefined = transaction?.tx.domain.data.storage
        ? transaction?.tx.domain.data.storage
        : undefined;
      const name: string | undefined = transaction?.tx.domain.name
        ? stringFromFields([transaction?.tx.domain.name])
        : undefined;
      const address: string | undefined = transaction?.tx.domain.data.address
        ? transaction?.tx.domain.data.address.toBase58()
        : undefined;
      const expiry: number | undefined = transaction?.tx.domain.data.expiry
        ? Number(transaction?.tx.domain.data.expiry.toBigInt())
        : undefined;
      let tx: any;
      try {
        tx = JSON.parse(item.tx.transaction);
      } catch (error) {
        console.error("Error parsing transaction", item.tx.transaction);
      }

      const data: TransactionJson = {
        txId: item.tx.txId,
        status: item.tx.status,
        name: name ?? tx?.name ?? "",
        operation: tx?.operation,
        address: address ?? tx?.address ?? "",
        timeReceived: item.tx.timeReceived,
        chain: chain,
        contractAddress: contractAddress,
        blockNumber: block?.blockNumber,
        blockHash,
        metadataRootKind: metadata?.kind.toJSON() ?? "",
        metadataRootData: metadata?.data.toJSON() ?? "",
        ipfs: storage?.toIpfsHash() ?? "",
        expiry: expiry ?? tx.expiry ?? 0,
      };
      for (const field of TransactionJsonFields.values) {
        if (
          field.optional !== true &&
          (data as any)[field.name] === undefined
        ) {
          console.error(`Transaction field ${field.name} is undefined`);
          return { success: false, blockHash };
        }
      }
      if (data.txId === undefined) {
        console.error("Error: txId is undefined", data);
        return { success: false, blockHash };
      }
      const result = await rollupTransactions.saveObject({
        objectID: data.txId,
        ...data,
      });
      if (result.taskID === undefined) {
        console.error(
          "Algolia write result for transaction",
          tx.txId,
          "is ",
          result
        );
        return { success: false, blockHash };
      }
    }
    return { success: true, blockHash };
  } catch (error) {
    console.error("alWriteBlock error:", { error, block });
    return { success: false, blockHash: undefined };
  }
}
