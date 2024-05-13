import {
  Field,
  SelfProof,
  ZkProgram,
  Struct,
  Poseidon,
  PublicKey,
  UInt64,
  Bool,
  UInt8,
  Signature,
  UInt32,
  MerkleMapWitness,
} from "o1js";
import { Metadata } from "../contract/metadata";
import { Storage } from "../contract/storage";
import { serializeFields, deserializeFields } from "zkcloudworker";

export type DomainTransactionType = "add" | "extend" | "update" | "remove"; // removeExpired
export type DomainTransactionStatus =
  | "sent"
  | "invalid"
  | "accepted"
  | "rejected";
export class RollupNftNameValue extends Struct({
  address: PublicKey,
  metadata: Metadata,
  storage: Storage,
  expiry: UInt64,
}) {
  hash(): Field {
    return Poseidon.hashPacked(RollupNftNameValue, this);
  }
  static empty(): RollupNftNameValue {
    return new RollupNftNameValue({
      address: PublicKey.empty(),
      metadata: new Metadata({ data: Field(0), kind: Field(0) }),
      storage: new Storage({ hashString: [Field(0), Field(0)] }),
      expiry: UInt64.from(0),
    });
  }
}

export class RollupNftName extends Struct({
  name: Field,
  data: RollupNftNameValue,
}) {
  static empty(): RollupNftName {
    return new RollupNftName({
      name: Field(0),
      data: RollupNftNameValue.empty(),
    });
  }

  isEmpty(): Bool {
    return this.data.expiry.equals(UInt64.from(0));
  }

  value(): Field {
    return this.data.hash();
  }

  key(): Field {
    return this.name;
  }

  hash(): Field {
    return Poseidon.hashPacked(RollupNftName, this);
  }
}

export const DomainTransactionEnum: { [k in DomainTransactionType]: UInt8 } = {
  add: UInt8.from(1),
  extend: UInt8.from(2),
  update: UInt8.from(3),
  remove: UInt8.from(4),
};

export class DomainTransaction extends Struct({
  type: UInt8,
  domain: RollupNftName,
}) {
  hash(): Field {
    return Poseidon.hashPacked(DomainTransaction, this);
  }
}

export class DomainTransactionData {
  constructor(
    public readonly tx: DomainTransaction,
    public readonly oldDomain?: RollupNftName,
    public readonly signature?: Signature
  ) {
    this.tx = tx;
    this.oldDomain = oldDomain;
    this.signature = signature;
  }

  public txType(): DomainTransactionType {
    return ["add", "extend", "update", "remove"][
      this.tx.type.toNumber() - 1
    ] as DomainTransactionType;
  }

  public toJSON() {
    this.validate();
    return {
      tx: serializeFields(DomainTransaction.toFields(this.tx)),
      oldDomain: this.oldDomain
        ? serializeFields(RollupNftName.toFields(this.oldDomain))
        : undefined,
      signature: this.signature?.toBase58(),
    };
  }

  static fromJSON(data: any): DomainTransactionData {
    const tx = new DomainTransaction(
      DomainTransaction.fromFields(deserializeFields(data.tx))
    );
    const oldDomain = data.oldDomain
      ? new RollupNftName(
          RollupNftName.fromFields(deserializeFields(data.oldDomain))
        )
      : undefined;
    const signature = data.signature
      ? Signature.fromBase58(data.signature)
      : undefined;
    const domain = new DomainTransactionData(tx, oldDomain, signature);
    domain.validate();
    return domain;
  }

  public validate() {
    const txType = this.txType();
    if (!this.oldDomain) {
      if (txType === "update" || txType === "extend")
        throw new Error(
          "oldDomain is required for update and extend transaction"
        );
    }
    if (!this.signature) {
      if (txType === "update")
        throw new Error("signature is required for update transaction");
    }
  }
}

export interface DomainSerializedTransaction {
  operation: DomainTransactionType;
  name: string;
  address: string;
  expiry: number;
  metadata?: string;
  storage?: string;
  newDomain?: string;
  oldDomain?: string;
  signature?: string;
}

export type DomainCloudTransactionStatus =
  | "sent"
  | "invalid"
  | "pending"
  | "accepted"
  | "rejected";
export interface DomainCloudTransaction {
  txId: string;
  transaction: string;
  timeReceived: number;
  newDomain?: string;
  fields?: string;
  status: DomainCloudTransactionStatus;
  reason?: string;
}

export interface DomainCloudTransactionData {
  serializedTx: DomainCloudTransaction;
  domainData: DomainTransactionData | undefined;
}

export class MapUpdateData extends Struct({
  oldRoot: Field,
  newRoot: Field,
  time: UInt64, // unix time when the map was updated
  tx: DomainTransaction,
  witness: MerkleMapWitness,
}) {}

export class MapTransition extends Struct({
  oldRoot: Field,
  newRoot: Field,
  time: UInt64, // unix time when the map was updated
  hash: Field, // sum of hashes of all the new keys and values of the Map
  count: UInt32, // number of new keys in the Map
}) {
  // TODO: addNew, replaceExpired, extend, change
  static add(update: MapUpdateData) {
    update.tx.type.assertEquals(DomainTransactionEnum.add);
    const key = update.tx.domain.name;
    const value = update.tx.domain.data.hash();

    const [rootBefore, keyBefore] = update.witness.computeRootAndKey(Field(0));
    update.oldRoot.assertEquals(rootBefore);
    key.assertEquals(keyBefore);

    const [rootAfter, keyAfter] = update.witness.computeRootAndKey(value);
    update.newRoot.assertEquals(rootAfter);
    key.assertEquals(keyAfter);

    const hash = update.tx.hash();

    return new MapTransition({
      oldRoot: update.oldRoot,
      newRoot: update.newRoot,
      hash,
      count: UInt32.from(1),
      time: update.time,
    });
  }

  static update(
    update: MapUpdateData,
    oldDomain: RollupNftName,
    signature: Signature
  ) {
    update.tx.type.assertEquals(DomainTransactionEnum.update);
    const key = update.tx.domain.name;
    key.assertEquals(oldDomain.name);
    const value = update.tx.domain.data.hash();
    const oldValue = oldDomain.data.hash();

    const [rootBefore, keyBefore] = update.witness.computeRootAndKey(oldValue);
    update.oldRoot.assertEquals(rootBefore);
    key.assertEquals(keyBefore);

    const [rootAfter, keyAfter] = update.witness.computeRootAndKey(value);
    update.newRoot.assertEquals(rootAfter);
    key.assertEquals(keyAfter);

    signature.verify(
      oldDomain.data.address,
      DomainTransaction.toFields(update.tx)
    );

    const hash = update.tx.hash();

    return new MapTransition({
      oldRoot: update.oldRoot,
      newRoot: update.newRoot,
      hash,
      count: UInt32.from(1),
      time: update.time,
    });
  }

  static extend(update: MapUpdateData, oldDomain: RollupNftName) {
    update.tx.domain.data.address.assertEquals(oldDomain.data.address);
    Metadata.assertEquals(
      update.tx.domain.data.metadata,
      oldDomain.data.metadata
    );
    Storage.assertEquals(update.tx.domain.data.storage, oldDomain.data.storage);
    update.tx.domain.data.expiry.assertGreaterThan(oldDomain.data.expiry);

    update.tx.type.assertEquals(DomainTransactionEnum.extend);
    const key = update.tx.domain.name;
    key.assertEquals(oldDomain.name);
    const value = update.tx.domain.data.hash();
    const oldValue = oldDomain.data.hash();

    const [rootBefore, keyBefore] = update.witness.computeRootAndKey(oldValue);
    update.oldRoot.assertEquals(rootBefore);
    key.assertEquals(keyBefore);

    const [rootAfter, keyAfter] = update.witness.computeRootAndKey(value);
    update.newRoot.assertEquals(rootAfter);
    key.assertEquals(keyAfter);

    const hash = update.tx.hash();

    return new MapTransition({
      oldRoot: update.oldRoot,
      newRoot: update.newRoot,
      hash,
      count: UInt32.from(1),
      time: update.time,
    });
  }

  static remove(update: MapUpdateData) {
    update.tx.type.assertEquals(DomainTransactionEnum.remove);
    update.tx.domain.data.expiry.assertLessThanOrEqual(update.time);
    const key = update.tx.domain.name;
    const value = update.tx.domain.data.hash();

    const [rootBefore, keyBefore] = update.witness.computeRootAndKey(value);
    update.oldRoot.assertEquals(rootBefore);
    key.assertEquals(keyBefore);

    const [rootAfter, keyAfter] = update.witness.computeRootAndKey(Field(0));
    update.newRoot.assertEquals(rootAfter);
    key.assertEquals(keyAfter);

    const hash = update.tx.hash();

    return new MapTransition({
      oldRoot: update.oldRoot,
      newRoot: update.newRoot,
      hash,
      count: UInt32.from(1),
      time: update.time,
    });
  }

  // Incorrect or unpaid txs are being rejected
  static reject(root: Field, time: UInt64, domain: DomainTransaction) {
    const hash = domain.hash();
    return new MapTransition({
      oldRoot: root,
      newRoot: root,
      hash,
      count: UInt32.from(1),
      time,
    });
  }

  static merge(transition1: MapTransition, transition2: MapTransition) {
    transition1.newRoot.assertEquals(transition2.oldRoot);
    transition1.time.assertEquals(transition2.time);
    return new MapTransition({
      oldRoot: transition1.oldRoot,
      newRoot: transition2.newRoot,
      hash: transition1.hash.add(transition2.hash),
      count: transition1.count.add(transition2.count),
      time: transition1.time,
    });
  }

  static assertEquals(transition1: MapTransition, transition2: MapTransition) {
    transition1.oldRoot.assertEquals(transition2.oldRoot);
    transition1.newRoot.assertEquals(transition2.newRoot);
    transition1.hash.assertEquals(transition2.hash);
    transition1.count.assertEquals(transition2.count);
    transition1.time.assertEquals(transition2.time);
  }
}

export const MapUpdate = ZkProgram({
  name: "MapUpdate",
  publicInput: MapTransition,
  overrideWrapDomain: 2,

  methods: {
    add: {
      privateInputs: [MapUpdateData],

      async method(state: MapTransition, update: MapUpdateData) {
        //Provable.log("MapUpdate.add state.hash:", state.hash);
        const computedState = MapTransition.add(update);
        MapTransition.assertEquals(computedState, state);
      },
    },

    update: {
      privateInputs: [MapUpdateData, RollupNftName, Signature],

      async method(
        state: MapTransition,
        update: MapUpdateData,
        oldDomain: RollupNftName,
        signature: Signature
      ) {
        const computedState = MapTransition.update(
          update,
          oldDomain,
          signature
        );
        MapTransition.assertEquals(computedState, state);
      },
    },

    extend: {
      privateInputs: [MapUpdateData, RollupNftName],

      async method(
        state: MapTransition,
        update: MapUpdateData,
        oldDomain: RollupNftName
      ) {
        const computedState = MapTransition.extend(update, oldDomain);
        MapTransition.assertEquals(computedState, state);
      },
    },

    remove: {
      privateInputs: [MapUpdateData],

      async method(state: MapTransition, update: MapUpdateData) {
        const computedState = MapTransition.remove(update);
        MapTransition.assertEquals(computedState, state);
      },
    },

    reject: {
      privateInputs: [Field, UInt64, DomainTransaction],

      async method(
        state: MapTransition,
        root: Field,
        time: UInt64,
        domain: DomainTransaction
      ) {
        const computedState = MapTransition.reject(root, time, domain);
        MapTransition.assertEquals(computedState, state);
      },
    },

    merge: {
      privateInputs: [SelfProof, SelfProof],

      async method(
        newState: MapTransition,
        proof1: SelfProof<MapTransition, void>,
        proof2: SelfProof<MapTransition, void>
      ) {
        proof1.verify();
        proof2.verify();
        const computedState = MapTransition.merge(
          proof1.publicInput,
          proof2.publicInput
        );
        MapTransition.assertEquals(computedState, newState);
      },
    },
  },
});

export class MapUpdateProof extends ZkProgram.Proof(MapUpdate) {}
