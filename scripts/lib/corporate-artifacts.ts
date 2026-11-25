import type { Plugin } from "vite-plus";

export function corporateArtifactsPlugin(edition: "standard" | "corporate"): Plugin {
  return {
    name: "t3code:corporate-artifacts",
    generateBundle(_options, bundle) {
      this.emitFile({
        type: "asset",
        fileName: "build-edition.json",
        source: JSON.stringify({ schemaVersion: 1, edition }) + "\n",
      });
      if (edition !== "corporate") return;
      const forbidden = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of Object.keys(chunk.modules)) {
          const normalized = id.replaceAll("\\", "/");
          if (
            normalized.includes("/node_modules/") &&
            (normalized.includes("/@clerk/") || normalized.includes("/electron-updater/"))
          ) {
            forbidden.add(id);
          }
        }
      }
      if (forbidden.size > 0) {
        this.error(
          `Corporate artifact includes excluded cloud modules:\n${[...forbidden].sort().join("\n")}`,
        );
      }
    },
  };
}
