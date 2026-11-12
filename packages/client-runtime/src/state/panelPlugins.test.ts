// @effect-diagnostics globalDate:off - Fixtures are local calendar days.
import { describe, expect, it } from "vite-plus/test";
import {
  matchPluginLink,
  pluginDateChoices,
  pluginLinkHref,
  pluginLinkTarget,
  toCalendarDate,
} from "./panelPlugins.ts";

describe("pluginDateChoices", () => {
  it.each([
    // Tuesday 10 Nov 2026: tomorrow Wed, the day after is Thursday, next week Mon 16.
    [new Date(2026, 10, 10, 23, 30), ["2026-11-11", "2026-11-12", "2026-11-16"], "Thursday"],
    // Sunday: next week is the following day, Monday.
    [new Date(2026, 10, 15, 9), ["2026-11-16", "2026-11-17", "2026-11-16"], "Tuesday"],
    // Monday: next week is a full week away, not today.
    [new Date(2026, 10, 16, 0, 5), ["2026-11-17", "2026-11-18", "2026-11-23"], "Wednesday"],
    // Month and year rollover stay in the local calendar.
    [new Date(2026, 11, 31, 22), ["2027-01-01", "2027-01-02", "2027-01-04"], "Saturday"],
  ])("resolves shortcuts from %s", (now, values, dayAfterLabel) => {
    const choices = pluginDateChoices(now, "en-AU");
    expect(choices.map((choice) => choice.value)).toEqual(values);
    expect(choices[1]?.label).toBe(dayAfterLabel);
  });

  it("formats local dates without a UTC shift", () => {
    expect(toCalendarDate(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");
  });
});

describe("matchPluginLink", () => {
  const links = [
    { pluginId: "viewer", linkId: "message", prefix: "https://viewer.example/msg/" },
    { pluginId: "viewer", linkId: "pacs", prefix: "https://viewer.example/msg/pacs/" },
    { pluginId: "staff", linkId: "person", prefix: "https://intranet.example/people/" },
    { pluginId: "docs", linkId: "markdown", glob: "/**/*.{md,markdown}" },
    { pluginId: "docs", linkId: "notes", glob: "/Users/*/notes/**/*.md" },
    { pluginId: "wiki", linkId: "page", glob: "https://*.wiki.example/?/*" },
  ];
  it.each([
    ["https://viewer.example/msg/camt.053/1", "message"],
    // Nested prefixes: the more specific declaration wins.
    ["https://viewer.example/msg/pacs/008", "pacs"],
    ["https://intranet.example/people/jdoe", "person"],
    // Prefix match is literal: another host, scheme or path is no match.
    ["https://viewer.example.evil/msg/1", undefined],
    ["http://viewer.example/msg/1", undefined],
    ["https://viewer.example/msgs/1", undefined],
    ["/repo/README.md", "markdown"],
    ["/repo/docs/guide.markdown", "markdown"],
    // Overlapping globs: the longer literal start wins.
    ["/Users/me/notes/2026/plan.md", "notes"],
    ["/repo/README.mdx", undefined],
    // An unnormalized path matches nothing, so `..` cannot escape a glob's directory.
    ["/Users/me/notes/../../../etc/passwd.md", undefined],
    // `*` and `?` stop at a slash; regex characters in a glob are literal.
    ["https://en.wiki.example/a/Page", "page"],
    ["https://en.wiki.example/ab/Page", undefined],
    ["https://evil.example/x.wiki.example/a/Page", undefined],
  ])("matches %s", (href, linkId) => {
    expect(matchPluginLink(links, href)?.linkId).toBe(linkId);
  });
});

describe("pluginLinkTarget", () => {
  it.each([
    ["https://a.example/x.md", "https://a.example/x.md"],
    ["docs/guide.md", "/repo/docs/guide.md"],
    ["./docs/../README.md#L3", "/repo/README.md"],
    ["file:///etc/notes.md", "/etc/notes.md"],
    ["mailto:a@b.example", undefined],
    ["#section", undefined],
  ])("%s", (href, expected) => {
    expect(pluginLinkTarget(href, "/repo")).toBe(expected);
  });
});

describe("pluginLinkHref", () => {
  const link = {
    pluginId: "viewer",
    linkId: "message",
    prefix: "https://viewer.example/msg/",
    href: "https://internal.example/view/{rest}?from={url}",
  };
  const url = "https://viewer.example/msg/pacs/008 a?x=1";
  it.each([
    ["a resolution wins", link, { href: "https://other.example/1" }, "https://other.example/1"],
    [
      "the template keeps rest's slashes and encodes the whole link",
      link,
      undefined,
      "https://internal.example/view/pacs/008%20a%3Fx%3D1?from=https%3A%2F%2Fviewer.example%2Fmsg%2Fpacs%2F008%20a%3Fx%3D1",
    ],
    ["no template keeps the link", { ...link, href: undefined }, undefined, url],
    [
      "a non-http result is ignored",
      { ...link, href: "javascript:alert(1)//{rest}" },
      { href: "file:///etc/passwd" },
      url,
    ],
  ])("%s", (_name, declared, resolution, expected) => {
    expect(pluginLinkHref(declared, url, resolution)).toBe(expected);
  });
});
