import { Cloud, zkCloudWorker, initBlockchain } from "zkcloudworker";
import { initializeBindings } from "o1js";
import { RollupWorker } from "./src/worker";

export async function zkcloudworker(cloud: Cloud): Promise<zkCloudWorker> {
  console.log("zkcloudworker cloud chain:", cloud.chain);
  await initializeBindings();
  await initBlockchain(cloud.chain);
  return new RollupWorker(cloud);
}
