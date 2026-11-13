import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { PluginLinkGlob, pluginLinkGlobMatches } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { reportMarkdownActionFailure } from "../chat/markdownActionFailure";
import { DraftInput } from "../ui/draft-input";
import { stackedThreadToast, toastManager } from "../ui/toast";

// Local storage, not client settings: the choice belongs to this device, and the fork adds no
// keys to the settings files it shares with official builds.
const DEFAULT_APP_LINK_GLOB_KEY = "t3code:default-app-link-glob";
const DEFAULT_APP_LINK_GLOB_EXAMPLE = "/**/*.{md,markdown}";
const isLinkGlob = Schema.is(PluginLinkGlob);

/** The glob of file links this device opens with the host's default application; empty is off. */
export function useDefaultAppLinkGlob() {
  return useLocalStorage(DEFAULT_APP_LINK_GLOB_KEY, "", Schema.String);
}

/** Whether a file link's normalized absolute `path` opens with the default application. */
export function opensWithDefaultApp(glob: string, path: string): boolean {
  return isLinkGlob(glob) && !/^https?:\/\//i.test(path) && pluginLinkGlobMatches(glob, path);
}

/**
 * A file chip whose plain click opens the file with the application the environment's machine
 * registers for it. A modified click keeps the chip's own behaviour.
 */
export function DefaultAppFileLink(props: {
  target: string;
  onOpen: () => Promise<AtomCommandResult<unknown, unknown>>;
  children: ReactNode;
}) {
  const reportFailure = (cause: unknown) => {
    reportMarkdownActionFailure(
      { operation: "open-file-in-default-app", target: props.target },
      cause,
    );
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open file",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      }),
    );
  };
  return (
    <span
      onClickCapture={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        // React also delivers clicks from portals the chip opens; those are not the chip.
        if (!event.currentTarget.contains(event.target as Node)) return;
        event.preventDefault();
        event.stopPropagation();
        void props.onOpen().then((result) => {
          if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
          reportFailure(squashAtomCommandFailure(result));
        }, reportFailure);
      }}
    >
      {props.children}
    </span>
  );
}

export function DefaultAppLinksSetting() {
  const [glob, setGlob] = useDefaultAppLinkGlob();
  return (
    <div className="flex flex-wrap items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-medium text-foreground">Open with the default application</div>
        <div className="text-xs text-muted-foreground">
          {glob !== "" && !isLinkGlob(glob)
            ? `Not a pattern, so no links match. Example: ${DEFAULT_APP_LINK_GLOB_EXAMPLE}`
            : "File links whose path matches this pattern open with the application this computer registers for them. Applies on this device, when T3 Code runs on the same computer as the environment. Elsewhere they open as usual."}
        </div>
      </div>
      <DraftInput
        nativeInput
        size="sm"
        className="w-full sm:w-64"
        aria-label="Open with the default application"
        placeholder={DEFAULT_APP_LINK_GLOB_EXAMPLE}
        autoCapitalize="none"
        spellCheck={false}
        maxLength={512}
        value={glob}
        onCommit={(next) => setGlob(next.trim())}
      />
    </div>
  );
}
