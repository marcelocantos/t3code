// @effect-diagnostics cryptoRandomUUID:off -- Synchronous callback registry creates revocable capabilities before emitting snapshots.
import type { PluginPanelSnapshot } from "@t3tools/contracts";

export const PLUGIN_GATEWAY_PREFIX = "/api/plugin-panels/";

/** Reject alternate path spellings before URL normalization can hide traversal. */
export function pluginRelativePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u0020?#]/.test(path))
    return false;
  try {
    const decoded = decodeURIComponent(path);
    return (
      !/[\\%\u0000-\u0020]/.test(decoded) &&
      !decoded.split("/").some((part) => part === "." || part === "..")
    );
  } catch {
    return false;
  }
}

export interface PluginGatewayGrant {
  readonly upstreamRoot: string;
  /** Absent for environment panels, which belong to no single thread or workspace. */
  readonly threadId: string | undefined;
  readonly cwd: string | undefined;
  readonly abort: AbortController;
  active: number;
}

/** In-memory capabilities are owned by live sidebar subscriptions, never persisted or logged. */
export class PluginGatewaySessions {
  private readonly grants = new Map<string, PluginGatewayGrant>();

  get(token: string) {
    return this.grants.get(token);
  }

  session(threadId: string | undefined, cwd: string | undefined, allowWeb = false) {
    const panels = new Map<string, { key: string; token: string }>();
    const revoke = (id: string) => {
      const previous = panels.get(id);
      if (!previous) return;
      this.grants.get(previous.token)?.abort.abort();
      this.grants.delete(previous.token);
      panels.delete(id);
    };
    return {
      close: () => {
        for (const id of panels.keys()) revoke(id);
      },
      rewrite: (snapshot: PluginPanelSnapshot, endpoint?: string): PluginPanelSnapshot => {
        const liveIds = new Set(
          snapshot.panels.filter((panel) => panel.kind === "web").map((panel) => panel.id),
        );
        for (const id of panels.keys()) if (!liveIds.has(id)) revoke(id);
        return {
          ...snapshot,
          panels: snapshot.panels.map((panel) => {
            if (panel.kind !== "web") return panel;
            if (!allowWeb)
              return {
                id: panel.id,
                title: panel.title,
                rows: [
                  {
                    id: "permission",
                    label: "Interactive plugins require permission to operate this environment.",
                  },
                ],
                filters: [],
                filter: "permission",
              };
            if (!endpoint || !pluginRelativePath(panel.path) || !panel.path.endsWith("/"))
              throw new Error("Invalid SPA root");
            const base = new URL(endpoint);
            base.protocol = base.protocol === "wss:" ? "https:" : "http:";
            const upstreamRoot = new URL(panel.path, base).href;
            const key = upstreamRoot;
            let entry = panels.get(panel.id);
            if (entry?.key !== key) {
              revoke(panel.id);
              const token = crypto.randomUUID();
              entry = { key, token };
              panels.set(panel.id, entry);
              this.grants.set(token, {
                upstreamRoot,
                threadId,
                cwd,
                abort: new AbortController(),
                active: 0,
              });
            }
            return { ...panel, path: `${PLUGIN_GATEWAY_PREFIX}${entry.token}/` };
          }),
        };
      },
    };
  }

  /** A grant outside any panel snapshot, such as a link card page; it lives until `revoke`. */
  grant(upstreamRoot: string) {
    const token = crypto.randomUUID();
    this.grants.set(token, {
      upstreamRoot,
      threadId: undefined,
      cwd: undefined,
      abort: new AbortController(),
      active: 0,
    });
    return {
      token,
      revoke: () => {
        this.grants.get(token)?.abort.abort();
        this.grants.delete(token);
      },
    };
  }

  close() {
    for (const grant of this.grants.values()) grant.abort.abort();
    this.grants.clear();
  }
}
