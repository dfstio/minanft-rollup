import { MerkleTree, Field } from "o1js";
import {
  fieldToBase64,
  fieldFromBase64,
  bigintFromBase64,
  bigintToBase64,
} from "zkcloudworker";

export function treeToJSON(tree: MerkleTree) {
  const nodes: { [key: string]: string } = {};
  for (const level in tree.nodes) {
    const node: string[] = [];
    for (const index in tree.nodes[level]) {
      node.push(bigintToBase64(BigInt(index)));
      node.push(fieldToBase64(tree.nodes[level][index]));
    }
    nodes[level] = node.join(".");
  }
  return {
    height: tree.height,
    nodes,
  };
}

export function treeFromJSON(json: any): MerkleTree {
  const tree = new MerkleTree(json.height);

  function setNode(level: number, index: bigint, value: Field) {
    (tree.nodes[level] ??= {})[index.toString()] = value;
  }

  for (const level in json.nodes) {
    const node = json.nodes[level].split(".");
    for (let i = 0; i < node.length; i += 2) {
      setNode(
        parseInt(level),
        bigintFromBase64(node[i]),
        fieldFromBase64(node[i + 1])
      );
    }
  }
  return tree;
}
