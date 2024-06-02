import algoliasearch from "algoliasearch";
import { stringHash } from "zkcloudworker";
import { ALGOLIA_KEY, ALGOLIA_PROJECT } from "../../env.json";
import {
  TransactionHistoryFields,
  BlockHistory,
  BlockHistoryFields,
  TransactionHistory,
} from "./types";

export async function algoliaWriteBlockHistory(
  block: BlockHistory
): Promise<boolean> {
  try {
    const client = algoliasearch(ALGOLIA_PROJECT, ALGOLIA_KEY);

    for (const field of BlockHistoryFields.values) {
      if ((block as any)[field.name] === undefined) {
        console.error(`Block field ${field.name} is undefined`);
        return false;
      }
    }

    const rollupBlocks = client.initIndex("rollup-blocks-history");
    const result = await rollupBlocks.saveObject({
      objectID: block.blockHash + "." + block.txId,
      ...block,
    });

    if (result.taskID === undefined) {
      console.error(
        "Algolia write result for block",
        block.blockNumber,
        "is ",
        result
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error("algoliaWriteBlockHistory error:", { error, block });
    return false;
  }
}

export async function algoliaWriteTransactionHistory(
  tx: TransactionHistory
): Promise<boolean> {
  try {
    const client = algoliasearch(ALGOLIA_PROJECT, ALGOLIA_KEY);

    for (const field of TransactionHistoryFields.values) {
      if (field.optional !== true && (tx as any)[field.name] === undefined) {
        console.error(`Transaction field ${field.name} is undefined`);
        return false;
      }
    }

    const index = client.initIndex("rollup-tx-history");
    const result = await index.saveObject({
      objectID: stringHash(JSON.stringify(tx)),
      ...tx,
    });

    if (result.taskID === undefined) {
      console.error("Algolia write result for tx", tx.txId, "is ", result);
      return false;
    }
    return true;
  } catch (error) {
    console.error("algoliaWriteTransactionHistory error:", { error, tx });
    return false;
  }
}
