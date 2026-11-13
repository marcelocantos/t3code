import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { DefaultAppFileLink, opensWithDefaultApp } from "./DefaultAppFileLink";

it("matches only file paths, and only with a pattern", () => {
  const glob = "/**/*.{md,markdown}";
  expect(opensWithDefaultApp(glob, "/work/notes/plan.md")).toBe(true);
  expect(opensWithDefaultApp(glob, "/work/src/main.go")).toBe(false);
  expect(opensWithDefaultApp(glob, "https://example.com/plan.md")).toBe(false);
  expect(opensWithDefaultApp("", "/work/notes/plan.md")).toBe(false);
  expect(opensWithDefaultApp("/work/notes/plan.md", "/work/notes/plan.md")).toBe(false);
});

it("opens on a plain click and leaves a modified click to the chip", async () => {
  const onOpen = vi.fn(async () => AsyncResult.success(undefined));
  const onChipClick = vi.fn();
  await using screen = await render(
    <DefaultAppFileLink target="/work/plan.md" onOpen={onOpen}>
      <a
        href="/work/plan.md"
        onClick={(event) => {
          event.preventDefault();
          onChipClick();
        }}
      >
        plan.md
      </a>
    </DefaultAppFileLink>,
  );
  const chip = screen.getByRole("link", { name: "plan.md" });

  await userEvent.click(chip);
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onChipClick).not.toHaveBeenCalled();

  await userEvent.click(chip, { modifiers: ["Shift"] });
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onChipClick).toHaveBeenCalledTimes(1);
});
