import { Field, MerkleMap } from "o1js";
import { RollupNftName } from "./transaction";
import { stringFromFields } from "../lib/hash";
import { serializeFields, deserializeFields } from "zkcloudworker";

export class DomainDatabase {
  data: { [name: string]: string } = {};

  constructor(data: { [name: string]: string } = {}) {
    this.data = data;
  }

  insert(domain: RollupNftName) {
    const name = stringFromFields([domain.name]);
    const value = serializeFields(RollupNftName.toFields(domain));
    this.data[name] = value;
  }

  remove(name: Field) {
    delete this.data[stringFromFields([name])];
  }

  get(name: Field): RollupNftName | undefined {
    const value = this.data[stringFromFields([name])];
    if (value === undefined) return undefined;
    return new RollupNftName(
      RollupNftName.fromFields(deserializeFields(value))
    );
  }

  put(name: Field, domain: RollupNftName | undefined) {
    if (domain === undefined) {
      this.remove(name);
    } else {
      this.insert(domain);
    }
  }

  getRoot(): Field {
    const map = new MerkleMap();
    Object.keys(this.data).map((key) => {
      const domain: RollupNftName = new RollupNftName(
        RollupNftName.fromFields(deserializeFields(this.data[key]))
      );
      const name = stringFromFields([domain.name]);
      if (name !== key) throw new Error("DomainDatabase: invalid key");
      map.set(domain.key(), domain.value());
    });
    return map.getRoot();
  }
}
