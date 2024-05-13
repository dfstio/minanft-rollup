import { PrivateKey, PublicKey } from "o1js";
import {
  BLOCK_PRODUCER_PRIVATE_KEY,
  VALIDATOR_PRIVATE_KEY,
  CONTRACT_PRIVATE_KEY,
  FIRST_BLOCK_PRIVATE_KEY,
} from "../env.json";

interface ContractConfig {
  contractPrivateKey: PrivateKey;
  contractAddress: string;
  firstBlockPrivateKey?: PrivateKey;
  firstBlockPublicKey?: PublicKey;
}

export const nameContract: ContractConfig = {
  contractPrivateKey: PrivateKey.fromBase58(CONTRACT_PRIVATE_KEY),
  contractAddress: "B62qo2gLfhzbKpSQw3G7yQaajEJEmxovqm5MBRb774PdJUw6a7XnNFT",

  firstBlockPrivateKey: PrivateKey.fromBase58(FIRST_BLOCK_PRIVATE_KEY),
  firstBlockPublicKey: PublicKey.fromBase58(
    "B62qqLW1fQQG9wYR6d8f4ZLf21TnLLJG97ckYkcpcq6ETkD7DuV1NFT"
  ),
};

export const blockProducer = {
  publicKey: PublicKey.fromBase58(
    "B62qnSBTWb683YML9Jq1ynX67ouwkHPHsbPh65UiVhHJjF3w7y4DFST"
  ),
  privateKey: PrivateKey.fromBase58(BLOCK_PRODUCER_PRIVATE_KEY),
};

export const validatorsPrivateKeys: PrivateKey[] = [
  PrivateKey.fromBase58(VALIDATOR_PRIVATE_KEY),
];
