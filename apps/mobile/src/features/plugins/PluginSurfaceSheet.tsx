import type {
  PluginBadge,
  PluginLeafAction,
  PluginSurface,
  PluginSurfaceBlock,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { Sheet } from "../../components/ui/Sheet";
import { useNowMinuteMs } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { parsePluginCalendarDate, pluginRowMenu } from "./pluginRowMenu";
import { usePluginRequests, type PluginRowScope } from "./usePluginRequests";

type Tone = NonNullable<PluginBadge["tone"]>;

const TONE_TEXT: Record<Tone, string> = {
  default: "text-foreground",
  muted: "text-foreground-muted",
  info: "text-primary-text",
  success: "text-primary-text",
  warning: "text-warning-foreground",
  danger: "text-danger-foreground",
};

export const pluginToneText = (tone: Tone | undefined) => TONE_TEXT[tone ?? "default"];

export function PluginBadges(props: { readonly badges: ReadonlyArray<PluginBadge> | undefined }) {
  if (!props.badges?.length) return null;
  return (
    <View className="flex-row flex-wrap gap-1">
      {props.badges.map((badge) => (
        <View
          key={`${badge.label}:${badge.tone ?? ""}`}
          className="rounded-full bg-subtle px-2 py-0.5"
        >
          <Text
            textRole="caption"
            className={cn("font-t3-medium", pluginToneText(badge.tone ?? "muted"))}
          >
            {badge.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * A surface the sheet shows; `surfaceId` names it in the requests its actions make. A surface an
 * action returned has no id of its own and reports the one it was opened from.
 */
export interface PluginSurfaceEntry {
  readonly surfaceId: string | undefined;
  readonly surface: PluginSurface;
}

type SurfaceAction = Extract<PluginSurfaceBlock, { type: "actions" }>["items"][number];
type FormBlock = Extract<PluginSurfaceBlock, { type: "form" }>;

/**
 * Mobile's hovercards and dialogs: one sheet holding a stack of surfaces. A list item or surface
 * action pushes a child; Back pops it, and closing the sheet closes every level.
 */
export function PluginSurfaceSheet(props: {
  readonly scope: PluginRowScope;
  readonly root: PluginSurfaceEntry;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const requests = usePluginRequests(props.scope.environmentId);
  const [stack, setStack] = useState<ReadonlyArray<PluginSurfaceEntry>>([props.root]);
  const [busy, setBusy] = useState(false);
  const nowMs = useNowMinuteMs();
  const level = stack.length - 1;
  const top = stack[level] ?? props.root;

  const pushChild = async (surfaceId: string, itemId?: string) => {
    setBusy(true);
    const surface = await requests
      .requestSurface(props.scope, surfaceId, itemId)
      .finally(() => setBusy(false));
    if (surface) setStack((current) => [...current, { surfaceId, surface }]);
  };

  const run = async (
    action: Exclude<PluginLeafAction, { kind: "agent" | "surface" }>,
    value: Parameters<typeof requests.runAction>[2],
  ) => {
    const invokedAt = level;
    setBusy(true);
    const result = await requests
      .runAction(props.scope, action, value, top.surfaceId)
      .finally(() => setBusy(false));
    if (!result) return;
    if (result.close && invokedAt === 0 && !result.surface) {
      props.onClose();
      return;
    }
    setStack((current) => {
      const kept = result.close ? current.slice(0, Math.max(1, invokedAt)) : current;
      if (!result.surface) return kept;
      const child = { surfaceId: top.surfaceId, surface: result.surface };
      return result.close && invokedAt === 0 ? [child] : [...kept, child];
    });
  };

  const runSurfaceAction = (action: SurfaceAction, value?: string | null) => {
    if (action.kind === "surface") void pushChild(action.surfaceId);
    else void run(action, value);
  };

  return (
    <Sheet title={top.surface.title} onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 px-5 pt-3"
        contentContainerStyle={{ paddingBottom: Math.max(20, insets.bottom) }}
      >
        {level > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Back to ${stack[level - 1]?.surface.title ?? "previous"}`}
            className="min-h-11 flex-row items-center gap-1 self-start active:opacity-70"
            onPress={() => setStack((current) => current.slice(0, -1))}
          >
            <SymbolView name="chevron.left" size={16} tintColorClassName="accent-primary-text" />
            <Text className="text-primary-text">{stack[level - 1]?.surface.title}</Text>
          </Pressable>
        ) : null}
        {top.surface.blocks.map((block, index) => (
          <SurfaceBlock
            // oxlint-disable-next-line react/no-array-index-key -- Blocks have no ids; the level prefix remounts a new surface's forms.
            key={`${level}-${index}`}
            block={block}
            nowMs={nowMs}
            busy={busy}
            canOperate={requests.canOperate}
            onOpenItem={(surfaceId, itemId) => void pushChild(surfaceId, itemId)}
            onAction={runSurfaceAction}
            onCustomDate={async (action) => {
              const date = await requests.askDate(action);
              if (date !== null) runSurfaceAction(action, date);
            }}
            onSubmit={(form, values) => {
              const action = {
                kind: "plugin" as const,
                id: form.actionId,
                label: form.submitLabel,
              };
              void run(action, values);
            }}
          />
        ))}
      </ScrollView>
    </Sheet>
  );
}

function SurfaceBlock(props: {
  readonly block: PluginSurfaceBlock;
  readonly nowMs: number;
  readonly busy: boolean;
  readonly canOperate: boolean;
  readonly onOpenItem: (surfaceId: string, itemId: string) => void;
  readonly onAction: (action: SurfaceAction, value?: string | null) => void;
  readonly onCustomDate: (action: Extract<SurfaceAction, { kind: "date" }>) => void;
  readonly onSubmit: (form: FormBlock, values: Record<string, string>) => void;
}) {
  const { block } = props;
  switch (block.type) {
    case "heading":
      return (
        <Text accessibilityRole="header" className="font-t3-medium text-base text-foreground">
          {block.text}
        </Text>
      );
    case "text":
      return (
        <Text selectable className={cn("text-sm", pluginToneText(block.tone))}>
          {block.text}
        </Text>
      );
    case "fields":
      return (
        <View className="gap-2 rounded-xl bg-grouped-card p-3">
          {block.items.map((item) => (
            <View key={`${item.label}:${item.value}`} className="flex-row gap-3">
              <Text className="w-28 text-sm text-foreground-muted">{item.label}</Text>
              <Text selectable className={cn("min-w-0 flex-1 text-sm", pluginToneText(item.tone))}>
                {item.value}
              </Text>
            </View>
          ))}
        </View>
      );
    case "list":
      return (
        <View className="overflow-hidden rounded-xl bg-grouped-card">
          {block.items.map((item, index) => {
            const content = (
              <>
                <View className="min-w-0 flex-1 gap-1">
                  <Text className="text-sm text-foreground">{item.label}</Text>
                  {item.detail ? (
                    <Text className="text-xs text-foreground-muted">{item.detail}</Text>
                  ) : null}
                  <PluginBadges badges={item.badges} />
                </View>
                {item.surfaceId ? (
                  <SymbolView name="chevron.right" size={14} tintColorClassName="accent-chevron" />
                ) : null}
              </>
            );
            const className = cn(
              "min-h-11 flex-row items-center gap-3 px-3 py-2",
              index > 0 && "border-t border-border-subtle",
            );
            const surfaceId = item.surfaceId;
            return surfaceId ? (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                accessibilityState={{ disabled: props.busy }}
                disabled={props.busy}
                className={cn(className, "active:opacity-70")}
                onPress={() => props.onOpenItem(surfaceId, item.id)}
              >
                {content}
              </Pressable>
            ) : (
              <View key={item.id} className={className}>
                {content}
              </View>
            );
          })}
        </View>
      );
    case "form":
      return props.canOperate ? (
        <SurfaceForm form={block} busy={props.busy} onSubmit={props.onSubmit} />
      ) : null;
    case "actions":
      return props.canOperate ? (
        <View className="flex-row flex-wrap gap-2">
          {block.items.map((action) =>
            action.kind === "date" ? (
              <DateActionMenu
                key={action.id}
                action={action}
                now={new Date(props.nowMs)}
                disabled={props.busy}
                onChoose={(value) => props.onAction(action, value)}
                onCustom={() => props.onCustomDate(action)}
              />
            ) : (
              <Button
                key={action.id}
                size="compact"
                label={action.label}
                tone={action.kind === "plugin" && action.tone === "danger" ? "danger" : "secondary"}
                disabled={props.busy}
                onPress={() => props.onAction(action)}
              />
            ),
          )}
        </View>
      ) : null;
  }
}

/** A date action's shortcuts, custom date and clear, as a menu on a pill. */
export function DateActionMenu(props: {
  readonly action: Extract<PluginLeafAction, { kind: "date" }>;
  readonly now: Date;
  readonly disabled?: boolean;
  readonly onChoose: (value: string | null) => void;
  readonly onCustom: () => void;
}) {
  const menu = pluginRowMenu([props.action], { agentActions: false, now: props.now });
  return (
    <Menu
      accessible
      accessibilityRole="button"
      accessibilityLabel={props.action.label}
      title={props.action.label}
      actions={[...(menu.actions[0]?.subactions ?? [])]}
      onPressAction={({ nativeEvent }) => {
        const selection = menu.resolve(nativeEvent.event);
        if (selection?.kind === "custom-date") props.onCustom();
        else if (selection?.kind === "run") props.onChoose(selection.value ?? null);
      }}
    >
      <ControlPill
        variant="pill"
        icon="calendar.badge.clock"
        label={props.action.label}
        accessibilityLabel={props.action.label}
        disabled={props.disabled}
      />
    </Menu>
  );
}

function SurfaceForm(props: {
  readonly form: FormBlock;
  readonly busy: boolean;
  readonly onSubmit: (form: FormBlock, values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(props.form.fields.map((field) => [field.id, field.value ?? ""])),
  );
  const submit = () => {
    for (const field of props.form.fields) {
      const value = (values[field.id] ?? "").trim();
      if (field.required && value === "") {
        Dialog.alert(`${field.label} is required`);
        return;
      }
      if (field.kind === "date" && value !== "" && parsePluginCalendarDate(value) === null) {
        Dialog.alert(`${field.label} must be a date as YYYY-MM-DD`);
        return;
      }
    }
    props.onSubmit(props.form, values);
  };
  return (
    <View className="gap-3">
      {props.form.fields.map((field) => (
        <View key={field.id} className="gap-1">
          <Text className="text-sm text-foreground-muted">
            {field.label}
            {field.required ? " *" : ""}
          </Text>
          <TextInput
            accessibilityLabel={field.label}
            value={values[field.id] ?? ""}
            onChangeText={(text) => setValues((current) => ({ ...current, [field.id]: text }))}
            placeholder={field.placeholder ?? (field.kind === "date" ? "YYYY-MM-DD" : undefined)}
            placeholderTextColorClassName="accent-foreground-muted"
            multiline={field.kind === "textarea"}
            textAlignVertical={field.kind === "textarea" ? "top" : "center"}
            keyboardType={field.kind === "date" ? "numbers-and-punctuation" : "default"}
            autoCapitalize={field.kind === "date" ? "none" : "sentences"}
            readOnly={props.busy}
            className={cn(
              "rounded-xl border border-input-border bg-input px-3 py-2 font-sans text-base text-foreground",
              field.kind === "textarea" ? "min-h-24 max-h-48" : "min-h-11",
            )}
          />
        </View>
      ))}
      <Button label={props.form.submitLabel} tone="primary" loading={props.busy} onPress={submit} />
    </View>
  );
}
