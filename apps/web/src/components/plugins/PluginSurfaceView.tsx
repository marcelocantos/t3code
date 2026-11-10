import type { PluginSurface, PluginSurfaceBlock } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import {
  PLUGIN_TONE_TEXT,
  PluginBadges,
  PluginCustomDateDialog,
  PluginDateMenuItems,
} from "./PluginActionControls";

type ActionsBlock = Extract<PluginSurfaceBlock, { type: "actions" }>;
export type PluginSurfaceAction = ActionsBlock["items"][number];
type ListItem = Extract<PluginSurfaceBlock, { type: "list" }>["items"][number];
type FormBlock = Extract<PluginSurfaceBlock, { type: "form" }>;

export interface PluginSurfaceHandlers {
  readonly onAction: (action: PluginSurfaceAction, value: string | null, anchor: Element) => void;
  readonly onSubmit: (form: FormBlock, values: Record<string, string>, anchor: Element) => void;
  readonly onOpenItem: (item: ListItem & { surfaceId: string }, anchor: Element) => void;
}

/** Renders a plugin's structured surface. Plugins supply data only; T3 owns every control. */
export function PluginSurfaceView({
  surface,
  handlers,
}: {
  surface: PluginSurface;
  handlers: PluginSurfaceHandlers;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 text-sm">
      {surface.blocks.map((block) => (
        <SurfaceBlock key={blockKey(block)} block={block} handlers={handlers} />
      ))}
    </div>
  );
}

/** Blocks carry no ids, so a block is keyed by what it shows. */
function blockKey(block: PluginSurfaceBlock): string {
  switch (block.type) {
    case "heading":
    case "text":
      return `${block.type}:${block.text}`;
    case "fields":
      return `fields:${block.items.map((item) => item.label).join("\u0000")}`;
    case "list":
      return `list:${block.items.map((item) => item.id).join("\u0000")}`;
    case "form":
      return `form:${block.id}`;
    case "actions":
      return `actions:${block.items.map((item) => item.id).join("\u0000")}`;
  }
}

function SurfaceBlock({
  block,
  handlers,
}: {
  block: PluginSurfaceBlock;
  handlers: PluginSurfaceHandlers;
}) {
  switch (block.type) {
    case "heading":
      return <h3 className="break-words font-semibold text-foreground">{block.text}</h3>;
    case "text":
      return (
        <p className={`whitespace-pre-wrap break-words ${PLUGIN_TONE_TEXT[block.tone ?? "muted"]}`}>
          {block.text}
        </p>
      );
    case "fields":
      return (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {block.items.map((item) => (
            <div key={item.label} className="contents">
              <dt className="text-muted-foreground">{item.label}</dt>
              <dd className={`break-words ${PLUGIN_TONE_TEXT[item.tone ?? "default"]}`}>
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      );
    case "list":
      return (
        <ul className="-mx-1 flex flex-col text-xs">
          {block.items.map((item) => {
            const body = (
              <>
                <span className="block break-words text-foreground">{item.label}</span>
                {item.detail ? (
                  <span className="mt-0.5 block whitespace-pre-wrap break-words text-muted-foreground">
                    {item.detail}
                  </span>
                ) : null}
                <PluginBadges badges={item.badges} />
              </>
            );
            const { surfaceId } = item;
            return (
              <li key={item.id}>
                {surfaceId === undefined ? (
                  <div className="flex flex-col gap-1 px-1 py-1">{body}</div>
                ) : (
                  <button
                    type="button"
                    className="flex w-full cursor-pointer flex-col gap-1 rounded-sm px-1 py-1 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={(event) =>
                      handlers.onOpenItem({ ...item, surfaceId }, event.currentTarget)
                    }
                  >
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      );
    case "form":
      return <SurfaceForm form={block} handlers={handlers} />;
    case "actions":
      return <SurfaceActions block={block} handlers={handlers} />;
  }
}

function SurfaceForm({ form, handlers }: { form: FormBlock; handlers: PluginSurfaceHandlers }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(form.fields.map((field) => [field.id, field.value ?? ""])),
  );
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        handlers.onSubmit(form, values, event.currentTarget);
      }}
    >
      {form.fields.map((field) => {
        const id = `plugin-form-${form.id}-${field.id}`;
        const common = {
          id,
          required: field.required ?? false,
          placeholder: field.placeholder,
          value: values[field.id] ?? "",
        };
        const set = (value: string) => setValues((current) => ({ ...current, [field.id]: value }));
        return (
          <div key={field.id} className="flex flex-col gap-1">
            <Label htmlFor={id}>{field.label}</Label>
            {field.kind === "textarea" ? (
              <Textarea {...common} rows={3} onChange={(event) => set(event.target.value)} />
            ) : (
              <Input
                {...common}
                nativeInput
                type={field.kind === "date" ? "date" : "text"}
                onChange={(event) => set(event.target.value)}
              />
            )}
          </div>
        );
      })}
      <div>
        <Button type="submit" size="sm">
          {form.submitLabel}
        </Button>
      </div>
    </form>
  );
}

function SurfaceActions({
  block,
  handlers,
}: {
  block: ActionsBlock;
  handlers: PluginSurfaceHandlers;
}) {
  const [customDate, setCustomDate] = useState<{
    action: Extract<PluginSurfaceAction, { kind: "date" }>;
    anchor: Element;
  } | null>(null);
  return (
    <div className="flex flex-wrap gap-1.5">
      {block.items.map((action) =>
        action.kind === "date" ? (
          <Menu key={action.id}>
            <MenuTrigger render={<Button size="sm" variant="outline" />}>
              {action.label}
            </MenuTrigger>
            <MenuPopup align="start">
              <PluginDateMenuItems
                action={action}
                onChoose={(value) => handlers.onAction(action, value, document.body)}
                onCustom={() => setCustomDate({ action, anchor: document.body })}
              />
            </MenuPopup>
          </Menu>
        ) : (
          <Button
            key={action.id}
            size="sm"
            variant={
              action.kind === "plugin" && action.tone === "danger"
                ? "destructive-outline"
                : "outline"
            }
            onClick={(event) => handlers.onAction(action, null, event.currentTarget)}
          >
            {action.label}
          </Button>
        ),
      )}
      <PluginCustomDateDialog
        action={customDate?.action ?? null}
        onClose={() => setCustomDate(null)}
        onChoose={(value) => {
          if (customDate !== null) handlers.onAction(customDate.action, value, customDate.anchor);
        }}
      />
    </div>
  );
}
