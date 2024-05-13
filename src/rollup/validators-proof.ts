import {
  Field,
  Poseidon,
  PublicKey,
  Signature,
  UInt32,
  VerificationKey,
  verify,
  MerkleTree,
} from "o1js";
import { validatorsPrivateKeys } from "../config";
import {
  ValidatorsDecision,
  ValidatorsDecisionState,
  ValidatorsVoting,
  ValidatorsVotingProof,
  ValidatorWitness,
  ValidatorsState,
} from "./validators";

export function getValidators(count: number) {
  const tree = new MerkleTree(3);
  const validators = validatorsPrivateKeys.map((key) => key.toPublicKey());
  let totalHash = Field(0);
  for (let i = 0; i < validators.length; i++) {
    const hash = Poseidon.hashPacked(PublicKey, validators[i]);
    tree.setLeaf(BigInt(i), hash);
    totalHash = totalHash.add(hash);
  }
  return {
    validators: new ValidatorsState({
      count: UInt32.from(count),
      root: tree.getRoot(),
      hash: totalHash,
    }),
    tree,
  };
}
export async function calculateValidatorsProof(
  decision: ValidatorsDecision,
  verificationKey: VerificationKey,
  verbose: boolean = false
) {
  const validators = validatorsPrivateKeys.map((key) => key.toPublicKey());
  const { tree, validators: validatorsState } = getValidators(0);

  const proofs: ValidatorsVotingProof[] = [];
  for (let i = 0; i < validators.length; i++) {
    if (verbose) console.log("proof", i);
    const signature = Signature.create(
      validatorsPrivateKeys[i],
      ValidatorsDecision.toFields(decision)
    );
    const witness = new ValidatorWitness(tree.getWitness(BigInt(i)));
    const state = ValidatorsDecisionState.vote(
      decision,
      validators[i],
      witness,
      signature
    );
    const proof = await ValidatorsVoting.vote(
      state,
      decision,
      validators[i],
      witness,
      signature
    );
    proofs.push(proof);
  }
  let proof = proofs[0];
  for (let i = 1; i < proofs.length; i++) {
    if (verbose) console.log("merge", i);
    const state = ValidatorsDecisionState.merge(
      proof.publicInput,
      proofs[i].publicInput
    );
    const mergedProof = await ValidatorsVoting.merge(state, proof, proofs[i]);
    proof = mergedProof;
    const ok = await verify(mergedProof.toJSON(), verificationKey);
    if (verbose) console.log("proof verified:", ok);
    if (!ok) {
      throw new Error("calculateValidatorsProof: Proof is not valid");
    }
  }
  return proof;
}
