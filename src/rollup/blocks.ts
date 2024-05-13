import { Field, UInt32, UInt64, MerkleMap } from "o1js";
import {
  MapUpdateData,
  MapTransition,
  DomainTransaction,
  DomainTransactionData,
  DomainTransactionType,
  DomainCloudTransactionData,
  RollupNftName,
} from "./transaction";
import { DomainDatabase } from "./database";
import { serializeFields } from "zkcloudworker";
import { stringFromFields } from "../lib/hash";
import { Metadata } from "../contract/metadata";
import { Storage } from "../contract/storage";

function isAccepted(
  element: DomainTransactionData,
  time: UInt64,
  map: MerkleMap
): { accepted: boolean; reason?: string } {
  if (element.txType() === "update") {
    if (element.oldDomain === undefined)
      return { accepted: false, reason: "no old domain" };
    if (element.signature === undefined)
      return { accepted: false, reason: "no signature" };
    //console.log("isAccepted: verifying signature", element);
    if (
      element.signature
        .verify(
          element.oldDomain.data.address,
          DomainTransaction.toFields(element.tx)
        )
        .toBoolean() === false
    )
      return { accepted: false, reason: "invalid signature" };

    const value = map.get(element.tx.domain.key());
    const oldValue = element.oldDomain.value();
    if (value.equals(oldValue).toBoolean() === false)
      return { accepted: false, reason: "the old domain does not match" };
  }

  if (element.txType() === "extend") {
    if (element.oldDomain === undefined)
      return { accepted: false, reason: "no old domain" };
    const value = map.get(element.tx.domain.key());
    const oldValue = element.oldDomain.value();
    if (value.equals(oldValue).toBoolean() === false)
      return { accepted: false, reason: "the old domain does not match" };
    if (
      element.tx.domain.data.expiry
        .greaterThan(element.oldDomain!.data.expiry)
        .toBoolean() === false
    )
      return {
        accepted: false,
        reason: "new expiry date is before the old expiry date",
      };
    if (
      element.tx.domain.name.equals(element.oldDomain.name).toBoolean() ===
      false
    )
      return {
        accepted: false,
        reason: "the name does not match",
      };
    if (
      element.tx.domain.data.address
        .equals(element.oldDomain.data.address)
        .toBoolean() === false
    )
      return {
        accepted: false,
        reason: "the address does not match",
      };
    if (
      Metadata.equals(
        element.tx.domain.data.metadata,
        element.oldDomain.data.metadata
      ).toBoolean() === false
    )
      return {
        accepted: false,
        reason: "the metadata does not match",
      };
    if (
      Storage.equals(
        element.tx.domain.data.storage,
        element.oldDomain.data.storage
      ).toBoolean() === false
    )
      return {
        accepted: false,
        reason: "the storage does not match",
      };
  }

  if (element.txType() === "remove") {
    if (element.tx.domain.data.expiry.greaterThan(time).toBoolean() === true)
      return {
        accepted: false,
        reason: "the domain name is not expired yet, cannot remove",
      };
    const value = map.get(element.tx.domain.key());
    if (element.tx.domain.value().equals(value).toBoolean() === false)
      return {
        accepted: false,
        reason: "the domain value does not match",
      };
  }

  if (element.txType() === "add") {
    if (map.get(element.tx.domain.name).equals(Field(0)).toBoolean() === false)
      return { accepted: false, reason: "the name already registered" };
  }

  return { accepted: true };
}

export function createBlock(params: {
  elements: DomainCloudTransactionData[];
  map: MerkleMap;
  database: DomainDatabase;
  time: UInt64;
}):
  | {
      oldRoot: Field;
      root: Field;
      txsHash: Field;
      txsCount: UInt32;
      invalidTxsCount: number;
      state: Field[];
      proofData: string[];
    }
  | undefined {
  const { elements, map, database, time } = params;
  console.log(`Calculating block for ${elements.length} elements...`);
  if (elements.length === 0) return undefined; // nothing to do

  interface ElementState {
    isElementAccepted: boolean;
    update?: MapUpdateData;
    oldRoot: Field;
    type: DomainTransactionType;
    element: DomainTransactionData;
  }

  const oldRoot = map.getRoot();
  let txsHash = Field(0);
  let invalidTxsCount = 0;
  let txsCount = 0;
  const proofData: string[] = [];
  let states: MapTransition[] = [];
  let finalState: MapTransition | undefined = undefined;
  //const updates: ElementState[] = [];

  for (const tx of elements) {
    if (tx.domainData === undefined) {
      invalidTxsCount++;
      console.log("Invalid transaction", tx);
    } else {
      txsCount++;
      const element = tx.domainData;
      const root = map.getRoot();
      const hash = element.tx.hash();
      txsHash = txsHash.add(hash);
      const txType = element.txType();
      let { accepted, reason } = isAccepted(element, time, map);
      //console.log("Processing transaction", { tx, accepted, reason });
      if (accepted) {
        tx.serializedTx.status = "accepted";
        const key = element.tx.domain.key();
        const value =
          txType === "remove" ? Field(0) : element.tx.domain.value();
        const oldValue = map.get(key);
        const oldDatabaseValue = database.get(key);
        let isStatePushed = false;

        try {
          map.set(key, value);
          const newRoot = map.getRoot();
          const updateData = new MapUpdateData({
            oldRoot: root,
            newRoot,
            time,
            tx: element.tx,
            witness: map.getWitness(key),
          });

          const update: ElementState = {
            isElementAccepted: true,
            update: updateData,
            oldRoot: root,
            type: txType,
            element,
          };
          const state =
            update.type === "add"
              ? MapTransition.add(update.update!)
              : update.type === "remove"
              ? MapTransition.remove(update.update!)
              : update.type === "update"
              ? MapTransition.update(
                  update.update!,
                  update.element.oldDomain!,
                  update.element.signature!
                )
              : MapTransition.extend(update.update!, update.element.oldDomain!);

          const tx = {
            time,
            oldRoot: update.oldRoot.toJSON(),
            type: update.type,
            isAccepted: update.isElementAccepted,
            state: serializeFields(MapTransition.toFields(state)),
            update: serializeFields(MapUpdateData.toFields(update.update!)),
            oldDomain: update.element.oldDomain
              ? serializeFields(
                  RollupNftName.toFields(update.element.oldDomain)
                )
              : undefined,
            signature: update.element.signature?.toBase58(),
          };
          const newState: MapTransition =
            finalState === undefined
              ? state
              : MapTransition.merge(finalState, state);

          isStatePushed = true;
          finalState = newState;
          states.push(state);
          proofData.push(JSON.stringify(tx, null, 2));
          if (txType === "remove") database.remove(key);
          else database.insert(element.tx.domain);
        } catch (e) {
          console.error(
            "createBlock: Error processing transaction for name",
            stringFromFields([element.tx.domain.name]),
            e
          );
          if (isStatePushed) {
            console.error(
              "createBlock: State is already pushed, but error has occurred"
            );
            return undefined;
          }
          map.set(key, oldValue);
          database.put(key, oldDatabaseValue);
          accepted = false;
          reason = "Rollup error: exception in processing transaction";
        }
      }

      if (!accepted) {
        console.log(
          `Transaction rejected: ${reason}, name: ${stringFromFields([
            element.tx.domain.name,
          ])}`,
          tx
        );
        tx.serializedTx.status = "rejected";
        tx.serializedTx.reason = reason ?? "invalid request";
        const update: ElementState = {
          isElementAccepted: false,
          oldRoot: root,
          type: txType,
          element,
        };
        try {
          const state = MapTransition.reject(
            update.oldRoot,
            time,
            update.element.tx
          );
          const tx = {
            time: time.toBigInt().toString(),
            oldRoot: update.oldRoot.toJSON(),
            type: update.type,
            isAccepted: update.isElementAccepted,
            state: serializeFields(MapTransition.toFields(state)),
            tx: serializeFields(DomainTransaction.toFields(update.element.tx)),
          };
          const newState: MapTransition =
            finalState === undefined
              ? state
              : MapTransition.merge(finalState, state);
          finalState = newState;
          states.push(state);
          proofData.push(JSON.stringify(tx, null, 2));
        } catch (e) {
          console.error(
            "createBlock: Error processing reject transaction for name",
            stringFromFields([update.element.tx.domain.name]),
            update,
            e
          );
          return undefined;
        }
      }
    }
  }

  if (finalState === undefined) return undefined;
  const state = MapTransition.toFields(finalState);
  const root = map.getRoot();

  console.log(
    `Block calculated: ${txsCount} transactions, invalid txs: ${invalidTxsCount}`
  );

  return {
    state,
    proofData,
    oldRoot,
    root,
    txsCount: UInt32.from(txsCount),
    invalidTxsCount,
    txsHash,
  };
}
