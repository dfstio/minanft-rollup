import { DomainSerializedTransaction } from "./transaction";
import { Storage } from "../contract/storage";
import { Metadata } from "../contract/metadata";
import { RollupNFT, FileData } from "minanft";
import { Field } from "o1js";
import { sleep } from "zkcloudworker";

export interface RollupNFTData {
  storage: Storage;
  metadataRoot: Metadata;
}

export interface ImageData {
  size: number;
  sha3_512: string;
  mimeType: string;
  filename: string;
  ipfsHash: string;
}

export async function createRollupNFT(
  tx: DomainSerializedTransaction
): Promise<RollupNFTData> {
  const nft = new RollupNFT({
    name: tx.name,
    address: tx.address,
  });

  const metadata = JSON.parse(tx.metadata || "{}");
  //console.log("metadata:", metadata);

  if (metadata.keys !== undefined) {
    for (const item of metadata.keys) {
      Object.keys(item).forEach((key) => {
        console.log(`Key: ${key}, Value: ${item[key]}`);
        nft.update({ key, value: item[key] });
      });
    }
  }

  if (metadata.description !== undefined) {
    //console.log("metadata.description:", metadata.description);
    nft.updateText({
      key: `description`,
      text: metadata.description,
    });
  }

  if (metadata.contractAddress !== undefined) {
    //console.log("metadata.contractAddress:", metadata.contractAddress);
    nft.updateText({
      key: `contractAddress`,
      text: metadata.contractAddress,
    });
  }

  if (metadata.image !== undefined) {
    //console.log("metadata.image:", metadata.image);
    nft.updateFileData({
      key: `image`,
      type: "image",
      data: getFileData(metadata.image),
    });
  }

  if (process.env.PINATA_JWT === undefined)
    throw new Error("Pinata JWT is undefined");
  //console.log("Preparing commit data...");
  await sleep(1000);
  await nft.prepareCommitData({ pinataJWT: process.env.PINATA_JWT });

  if (nft.storage === undefined) throw new Error("Storage is undefined");
  if (nft.metadata === undefined) throw new Error("Metadata is undefined");
  const storage = new Storage({
    hashString: [nft.storage.hashString[0], nft.storage.hashString[1]],
  });
  const metadataRoot = new Metadata({
    data: nft.metadataRoot.data,
    kind: nft.metadataRoot.kind,
  });
  /*
  console.log(
    "RollupNFT created successfully, ipfs:",
    nft.storage.toIpfsHash()
  );
  */
  return { storage, metadataRoot } as RollupNFTData;
}

export function getFileData(params: {
  size: number;
  sha3_512: string;
  mimeType: string;
  filename: string;
  ipfsHash: string;
}): FileData {
  const { size, sha3_512, mimeType, filename, ipfsHash } = params;

  return new FileData({
    fileRoot: Field(0),
    height: 0,
    size,
    mimeType: mimeType.substring(0, 30),
    sha3_512,
    filename: filename.substring(0, 30),
    storage: "i:" + ipfsHash,
    fileType: "binary",
  });
}
