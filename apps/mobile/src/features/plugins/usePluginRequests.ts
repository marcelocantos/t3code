import { useAtomValue } from "@effect/atom-react";
import { pluginDateChoices } from "@t3tools/client-runtime/state/panelPlugins";
import type {
  EnvironmentId,
  PluginActionResult,
  PluginActionValue,
  PluginLeafAction,
  PluginPanelTarget,
  PluginSurface,
} from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { useAtomCommand } from "../../state/use-atom-command";
import { pluginFailureMessage, pluginPanelCommands } from "./pluginAtoms";
import { parsePluginCalendarDate } from "./pluginRowMenu";

/** The row an action or surface request is about. */
export interface PluginRowScope {
  readonly environmentId: EnvironmentId;
  readonly target: PluginPanelTarget;
  readonly pluginId: string;
  readonly panelId: string;
  readonly rowId: string;
}

type DateAction = Extract<PluginLeafAction, { kind: "date" }>;

const confirmAsync = (title: string, message: string, confirmText: string) =>
  new Promise<boolean>((resolve) =>
    Dialog.confirm({
      title,
      message,
      confirmText,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    }),
  );

/** Plugin actions and surfaces for one environment; failures are shown to the user here. */
export function usePluginRequests(environmentId: EnvironmentId) {
  const act = useAtomCommand(pluginPanelCommands.act, { reportFailure: false });
  const fetchSurface = useAtomCommand(pluginPanelCommands.surface, { reportFailure: false });
  const canOperate = useAtomValue(pluginPanelCommands.act.permissionAtom(environmentId));

  const runAction = async (
    scope: PluginRowScope,
    action: Exclude<PluginLeafAction, { kind: "agent" | "surface" }>,
    value: PluginActionValue | undefined,
    surfaceId?: string,
  ): Promise<PluginActionResult | null> => {
    if (
      action.kind === "plugin" &&
      action.confirm !== undefined &&
      !(await confirmAsync(action.label, action.confirm, action.label))
    ) {
      return null;
    }
    const { environmentId: _environmentId, ...rest } = scope;
    const result = await act({
      environmentId: scope.environmentId,
      input: {
        ...rest,
        actionId: action.id,
        ...(surfaceId === undefined ? {} : { surfaceId }),
        ...(value === undefined ? {} : { value }),
      },
    });
    if (result._tag === "Success") return result.value;
    Dialog.alert(`Could not ${action.label.toLowerCase()}`, pluginFailureMessage(result.cause));
    return null;
  };

  const requestSurface = async (
    scope: PluginRowScope,
    surfaceId: string,
    itemId?: string,
  ): Promise<PluginSurface | null> => {
    const { environmentId: _environmentId, ...rest } = scope;
    const result = await fetchSurface({
      environmentId: scope.environmentId,
      input: { ...rest, surfaceId, ...(itemId === undefined ? {} : { itemId }) },
    });
    if (result._tag === "Success") return result.value;
    Dialog.alert("Could not open", pluginFailureMessage(result.cause));
    return null;
  };

  /** Asks for a `YYYY-MM-DD` date; resolves null when cancelled or invalid. */
  const askDate = (action: DateAction) =>
    new Promise<string | null>((resolve) =>
      Dialog.prompt({
        title: action.label,
        message: "Enter a date as YYYY-MM-DD.",
        placeholder: "YYYY-MM-DD",
        initialValue: action.value ?? pluginDateChoices(new Date())[0]?.value ?? "",
        confirmText: "Set",
        onCancel: () => resolve(null),
        onConfirm: (text) => {
          const date = parsePluginCalendarDate(text);
          if (date === null) Dialog.alert("Not a date", `“${text}” is not a YYYY-MM-DD date.`);
          resolve(date);
        },
      }),
    );

  return { canOperate, runAction, requestSurface, askDate };
}
