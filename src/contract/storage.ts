import { Struct, Field, Encoding, Provable, Bool } from "o1js";
import axios from "axios";
import { makeString } from "zkcloudworker";

/**
 * Storage is the hash of the IPFS or Arweave storage where the metadata is written
 * format of the IPFS hash string: i:...
 * format of the Arweave hash string: a:...
 * @property hashString The hash string of the storage
 */
export class Storage extends Struct({
  hashString: Provable.Array(Field, 2),
}) {
  constructor(value: { hashString: [Field, Field] }) {
    super(value);
  }

  static empty(): Storage {
    return new Storage({ hashString: [Field(0), Field(0)] });
  }

  static assertEquals(a: Storage, b: Storage) {
    a.hashString[0].assertEquals(b.hashString[0]);
    a.hashString[1].assertEquals(b.hashString[1]);
  }

  static equals(a: Storage, b: Storage): Bool {
    return a.hashString[0]
      .equals(b.hashString[0])
      .and(a.hashString[1].equals(b.hashString[1]));
  }

  static fromIpfsHash(hash: string): Storage {
    const fields = Encoding.stringToFields("i:" + hash);
    if (fields.length !== 2) throw new Error("Invalid IPFS hash");
    return new Storage({ hashString: [fields[0], fields[1]] });
  }

  toIpfsHash(): string {
    const hash = Encoding.stringFromFields(this.hashString);
    if (hash.startsWith("i:")) {
      return hash.substring(2);
    } else throw new Error("Invalid IPFS hash");
  }
}

const ipfsData: { [key: string]: string } = {};
let useLocalIpfsData = false;

export async function saveToIPFS(params: {
  data: any;
  pinataJWT: string;
  name: string;
  keyvalues?: object;
}): Promise<string | undefined> {
  const { data, pinataJWT, name, keyvalues } = params;
  //console.log("saveToIPFS:", { name });
  if (pinataJWT === "local") {
    const hash = makeString(
      `QmTosaezLecDB7bAoUoXcrJzeBavHNZyPbPff1QHWw8xus`.length
    );
    ipfsData[hash] = data;
    useLocalIpfsData = true;
    return hash;
  }

  try {
    const pinataData = {
      pinataOptions: {
        cidVersion: 1,
      },
      pinataMetadata: {
        name,
        keyvalues,
      },
      pinataContent: data,
    };
    const str = JSON.stringify(pinataData);
    const auth = "Bearer " + pinataJWT ?? "";

    const config = {
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
    };

    if (auth === "Bearer ")
      //for running tests
      return `QmTosaezLecDB7bAoUoXcrJzeBavHNZyPbPff1QHWw8xus`;

    const res = await axios.post(
      "https://api.pinata.cloud/pinning/pinJSONToIPFS",
      str,
      config
    );

    console.log("saveToIPFS result:", { result: res.data, name, keyvalues });
    return res.data.IpfsHash;
  } catch (error: any) {
    console.error("saveToIPFS error:", error?.message, { name, keyvalues });
    return undefined;
  }
}

export async function loadFromIPFS(hash: string): Promise<any | undefined> {
  if (useLocalIpfsData) {
    return ipfsData[hash];
  }
  try {
    const url =
      "https://salmon-effective-amphibian-898.mypinata.cloud/ipfs/" +
      hash +
      "?pinataGatewayToken=gFuDmY7m1Pa5XzZ3bL1TjPPvO4Ojz6tL-VGIdweN1fUa5oSFZXce3y9mL8y1nSSU";
    //"https://gateway.pinata.cloud/ipfs/" + hash;
    const result = await axios.get(url);
    return result.data;
  } catch (error: any) {
    console.error("loadFromIPFS error:", error?.message);
    return undefined;
  }
}
