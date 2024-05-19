import algoliasearch from "algoliasearch";
import { deserializeFields } from "minanft";
import { ALGOLIA_KEY, ALGOLIA_PROJECT } from "../../env.json";
import { Storage } from "../contract/storage";
import { Metadata } from "../contract/metadata";
import { stringHash } from "zkcloudworker";

export async function algoliaWriteBlock(params: {
  contractAddress: string;
  chain: string;
  block?: any;
  txs?: any[];
}): Promise<boolean> {
  const { contractAddress, chain, block, txs } = params;
  let hash: string | undefined = undefined;
  try {
    const client = algoliasearch(ALGOLIA_PROJECT, ALGOLIA_KEY);

    if (block) {
      const rollupBlocks = client.initIndex("rollup-blocks");
      hash = stringHash(
        JSON.stringify({
          chain,
          contractAddress,
          blockNumber: block.blockNumber,
          blockAddress: block.blockAddress,
        })
      );
      const objectID = hash;
      const blockData = {
        objectID,
        chain,
        contractAddress,
        ...block,
        ipfsUrl: "https://gateway.pinata.cloud/ipfs/" + block.ipfs,
      };
      blockData.timeCreated = Number(blockData.timeCreated);
      //console.log("blockData", blockData);

      const result = await rollupBlocks.saveObject(blockData);

      if (result.taskID === undefined)
        console.log(
          "Algolia write result for block",
          block.blockNumber,
          "is ",
          result
        );
    }

    if (!txs) return true;
    const rollupTransactions = client.initIndex("rollup-txs");
    for (const tx of txs) {
      const data = {
        objectID: tx.txId,
        txId: tx.txId,
        status: tx.status,
        timeReceived: tx.timeReceived,
        timeIncluded: Number(block?.timeCreated),
        chain: chain,
        contractAddress: contractAddress,
        blockNumber: block?.blockNumber,
        blockHash: hash,
        transaction: JSON.parse(tx.transaction),
      };
      data.transaction.ipfs = (
        Storage.fromFields(
          deserializeFields(data.transaction.storage)
        ) as Storage
      ).toIpfsHash();
      data.transaction.ipfsUrl =
        "https://gateway.pinata.cloud/ipfs/" + data.transaction.ipfs;
      const metadata = Metadata.fromFields(
        deserializeFields(data.transaction.metadata)
      ) as Metadata;
      data.transaction.metadataRoot = {
        data: metadata.data.toJSON(),
        kind: metadata.kind.toJSON(),
      };
      delete data.transaction.metadata;
      delete data.transaction.storage;
      //console.log("transaction", data);
      const result = await rollupTransactions.saveObject(data);
      if (result.taskID === undefined)
        console.log(
          "Algolia write result for transaction",
          tx.tx.txId,
          "is ",
          result
        );
    }
    return true;
  } catch (error) {
    console.error("alWriteBlock error:", { error, block });
    return false;
  }
}
