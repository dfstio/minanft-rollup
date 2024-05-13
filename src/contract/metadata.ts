import { Struct, Field, Bool } from "o1js";
/**
 * Metadata is the metadata of the NFT written to the Merkle Map
 * @property data The root of the Merkle Map of the data or data itself if it is a leaf
 * @property kind The root of the Merkle Map of the kind or kind itself if it is a leaf.
 * Kind can be one of the "string" or "text" or "map" or "image" or any string like "mykind"
 */
export class Metadata extends Struct({
  data: Field,
  kind: Field,
}) {
  /**
   * Asserts that two Metadata objects are equal
   * @param state1 first Metadata object
   * @param state2 second Metadata object
   */
  static assertEquals(state1: Metadata, state2: Metadata) {
    state1.data.assertEquals(state2.data);
    state1.kind.assertEquals(state2.kind);
  }

  static equals(state1: Metadata, state2: Metadata): Bool {
    return state1.data.equals(state2.data).and(state1.kind.equals(state2.kind));
  }
}
