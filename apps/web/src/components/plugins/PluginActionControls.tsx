import {
  formatCalendarDate,
  pluginDateChoices,
  toCalendarDate,
} from "@t3tools/client-runtime/state/panelPlugins";
import type { PluginAction, PluginBadge as PluginBadgeData } from "@t3tools/contracts";
import { useState } from "react";
import { useNowMinute } from "../../hooks/useNowMinute";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  MenuItem,
  MenuItemDetail,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";

/** The minute tick is UTC without a zone suffix. */
function useNowMinuteDate() {
  return new Date(`${useNowMinute()}Z`);
}

export type PluginTone = NonNullable<PluginBadgeData["tone"]>;
type DateAction = Extract<PluginAction, { kind: "date" }>;

const BADGE_VARIANT = {
  default: "outline",
  muted: "secondary",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "error",
} as const satisfies Record<PluginTone, string>;

export const PLUGIN_TONE_TEXT: Record<PluginTone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  info: "text-info-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  danger: "text-destructive-foreground",
};

export function PluginBadges({ badges }: { badges: ReadonlyArray<PluginBadgeData> | undefined }) {
  if (badges === undefined || badges.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {badges.map((badge) => (
        <Badge
          key={`${badge.tone ?? "default"}:${badge.label}`}
          size="sm"
          variant={BADGE_VARIANT[badge.tone ?? "default"]}
        >
          {badge.label}
        </Badge>
      ))}
    </span>
  );
}

/** The date choices of a date action, for a menu or submenu popup. */
export function PluginDateMenuItems({
  action,
  onChoose,
  onCustom,
}: {
  action: DateAction;
  onChoose: (value: string | null) => void;
  onCustom: () => void;
}) {
  const now = useNowMinuteDate();
  return (
    <>
      {pluginDateChoices(now).map((choice) => (
        <MenuItem key={choice.id} onClick={() => onChoose(choice.value)}>
          {choice.label}
          <MenuItemDetail>{choice.hint}</MenuItemDetail>
        </MenuItem>
      ))}
      <MenuItem onClick={onCustom}>Custom…</MenuItem>
      {action.value === undefined ? null : (
        <>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={() => onChoose(null)}>
            {action.clearLabel ?? "Clear"}
          </MenuItem>
        </>
      )}
    </>
  );
}

/**
 * Menu entries for actions. `run` gets a leaf action and, for dates, the chosen value; `menu`
 * actions become submenus.
 */
export function PluginActionMenuItems({
  actions,
  run,
  onCustomDate,
}: {
  actions: ReadonlyArray<PluginAction>;
  run: (action: Exclude<PluginAction, { kind: "menu" }>, value?: string | null) => void;
  onCustomDate: (action: DateAction) => void;
}) {
  return actions.map((action) => {
    switch (action.kind) {
      case "menu":
        return (
          <MenuSub key={action.id}>
            <MenuSubTrigger>{action.label}</MenuSubTrigger>
            <MenuSubPopup>
              <PluginActionMenuItems actions={action.items} run={run} onCustomDate={onCustomDate} />
            </MenuSubPopup>
          </MenuSub>
        );
      case "date":
        return (
          <MenuSub key={action.id}>
            <MenuSubTrigger>
              {action.label}
              {action.value === undefined ? null : (
                <MenuItemDetail>{formatCalendarDate(action.value)}</MenuItemDetail>
              )}
            </MenuSubTrigger>
            <MenuSubPopup>
              <PluginDateMenuItems
                action={action}
                onChoose={(value) => run(action, value)}
                onCustom={() => onCustomDate(action)}
              />
            </MenuSubPopup>
          </MenuSub>
        );
      default:
        return (
          <MenuItem
            key={action.id}
            variant={
              action.kind === "plugin" && action.tone === "danger" ? "destructive" : "default"
            }
            onClick={() => run(action)}
          >
            {action.label}
          </MenuItem>
        );
    }
  });
}

/** Asks for a date the shortcuts do not cover. */
export function PluginCustomDateDialog({
  action,
  onClose,
  onChoose,
}: {
  action: DateAction | null;
  onClose: () => void;
  onChoose: (value: string) => void;
}) {
  return (
    <Dialog open={action !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {action === null ? null : (
        <CustomDateForm key={action.id} action={action} onClose={onClose} onChoose={onChoose} />
      )}
    </Dialog>
  );
}

function CustomDateForm({
  action,
  onClose,
  onChoose,
}: {
  action: DateAction;
  onClose: () => void;
  onChoose: (value: string) => void;
}) {
  const now = useNowMinuteDate();
  const [value, setValue] = useState(action.value ?? toCalendarDate(now));
  return (
    <DialogPopup>
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
          onChoose(value);
          onClose();
        }}
      >
        <DialogHeader>
          <DialogTitle>{action.label}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Input
            nativeInput
            type="date"
            aria-label={`${action.label} date`}
            required
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Set date</Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
