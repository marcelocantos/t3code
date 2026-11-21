import { T, useGT, useMessages } from "gt-react";
import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import { MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator } from "../ui/menu";
import {
  isDefaultThreadDetailsVisibility,
  resolveThreadDetailsVisibility,
  RESET_THREAD_DETAILS_ITEMS,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
  type ThreadDetailsItemId,
} from "./threadDetailsItems";

/**
 * Menu body that shows and hides thread details items. The card's context menu and Settings share
 * it; the card passes the items its plugin panels replace, so they read as replaced, not shown.
 */
export function ThreadDetailsItemsMenuItems(props: {
  replaced?: ReadonlyMap<ThreadDetailsItemId, string>;
}) {
  const visibility = useClientSettings(resolveThreadDetailsVisibility);
  const keepReplaced = useClientSettings((settings) => settings.threadDetailsKeepReplaced);
  const m = useMessages();
  const gt = useGT();
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>
          <T>Show in thread details</T>
        </MenuGroupLabel>
        {THREAD_DETAILS_ITEMS.map((item) => {
          const replacedBy = props.replaced?.get(item.id);
          const kept = keepReplaced.includes(item.id);
          return (
            <MenuCheckboxItem
              key={item.id}
              checked={visibility[item.id] && (replacedBy === undefined || kept)}
              onCheckedChange={(checked) => {
                const settings = getClientSettings();
                if (replacedBy === undefined) {
                  updateClientSettings({
                    threadDetailsItems: setThreadDetailsItem(settings, item, checked),
                  });
                  return;
                }
                // A replaced item's toggle keeps it beside the plugin's panel or lets the panel
                // replace it again; the item's own choice still applies when the plugin is gone.
                const others = settings.threadDetailsKeepReplaced.filter((id) => id !== item.id);
                updateClientSettings(
                  checked
                    ? {
                        threadDetailsItems: setThreadDetailsItem(settings, item, true),
                        threadDetailsKeepReplaced: [...others, item.id],
                      }
                    : { threadDetailsKeepReplaced: others },
                );
              }}
            >
              {m(item.label)}
              {replacedBy !== undefined && !kept ? (
                <span className="ml-auto truncate pl-3 text-muted-foreground">
                  {gt("Replaced by {name}", { name: replacedBy })}
                </span>
              ) : null}
            </MenuCheckboxItem>
          );
        })}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem
        disabled={isDefaultThreadDetailsVisibility(visibility) && keepReplaced.length === 0}
        onClick={() => updateClientSettings(RESET_THREAD_DETAILS_ITEMS)}
      >
        <T>Reset to default</T>
      </MenuItem>
    </>
  );
}
