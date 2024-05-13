import algoliasearch from "algoliasearch";
import removeMarkdown from "remove-markdown";
import { MinaNFT } from "minanft";
import { ALGOLIA_KEY, ALGOLIA_PROJECT } from "../../env.json";

export async function algoliaWriteToken(params: {
  token: any;
  chain: string;
  name: string;
  address: string;
  ipfs: string;
  explorerAccount: string;
}): Promise<boolean> {
  const { token, chain, ipfs, explorerAccount, address, name } = params;
  const client = algoliasearch(ALGOLIA_PROJECT, ALGOLIA_KEY);
  const index = client.initIndex("minanft");
  console.log("alWriteToken");

  const success = await algoliaWriteTokenHelper({
    token,
    index,
    chain,
    ipfs,
    address,
    name,
    explorerAccount,
  });

  if (success)
    console.log(`Algolia index updated, token ${token.username} written`);
  else console.error("Error. Algolia index NOT updated");
  return success;
}

async function algoliaWriteTokenHelper(args: {
  token: any;
  index: any;
  chain: string;
  ipfs: string;
  address: string;
  name: string;
  explorerAccount: string;
}): Promise<boolean> {
  const { token, index, chain, ipfs, explorerAccount, name, address } = args;
  try {
    console.log("algoliaWriteTokenHelper", args);

    let params = token;
    const markdown = params.description;
    const description = removeMarkdown(params.description);
    let shortdescription = description;
    if (shortdescription.length > 70) {
      shortdescription = description.slice(0, 70) + "...";
    }

    if (name !== params.name) {
      console.error("Error: name mismatch", name, params.name);
      return false;
    }
    params.objectID = "RollupNFT" + name;

    params.description = description;
    params.url = params.external_url;
    params.category =
      params.properties?.category?.kind === "string"
        ? params.properties?.category?.data ?? "RollupNFT"
        : "RollupNFT token";
    params.type = "nft";
    params.contract = "v2";
    params.chainId = chain;
    params.tokenId = "/nft/i" + ipfs;
    params.updated = Date.now();
    params.minaPublicKey = address;
    params.address = address;
    params.owner = address;
    params.minaExplorer = explorerAccount;
    params.minaPublicKey = token.address;

    params.shortdescription = shortdescription;
    params.markdown = markdown;
    params.uri = MinaNFT.urlFromStorageString("i:" + ipfs);
    params.onSale = token.onSale ? true : false;
    params.saleID = "";
    params.saleStatus = token.onSale ? "on sale" : "not on sale";
    params.price = token.price ? token.price : 0;
    params.currency = token.currency ? token.currency.toUpperCase() : "";
    params.sale = "";
    const creator = params.creator ?? "ZekoRollupNFT";
    params.creator = creator;

    console.log("Algolia write ", name, params);

    const result = await index.saveObject(params);

    console.log(
      "Algolia write result for token",
      token.username,
      "is ",
      result
    );

    return true;
  } catch (error) {
    console.error("alWriteToken error:", error, token);
    return false;
  }
}
