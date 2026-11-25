import { app } from "electron";
import { corporateBuild } from "@t3tools/shared/buildEdition";
import { installCorporateNetworkPolicy } from "./NetworkPolicy.ts";

if (corporateBuild) {
  if (process.versions.t3_corporate_network !== "loopback-v1") {
    throw new Error("The corporate build requires its bundled loopback-only Electron runtime.");
  }
  installCorporateNetworkPolicy(app);
}
