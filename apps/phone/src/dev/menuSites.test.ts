import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const COMPONENTS = join(import.meta.dirname, "..", "components");

type Over = "frostable" | "page" | "sheet" | "system";

const SITES: Record<string, Over> = {
  "browsing/BrowsingScreen.tsx": "page",
  "browsing/PageMenu.tsx": "sheet",
  "browsing/PageMenuWords.tsx": "sheet",
  "browsing/PageRequests.tsx": "page",
  "browsing/ReaderView.tsx": "page",
  "browsing/tabsMenu.tsx": "page",
  "column/DeckColumn.tsx": "page",
  "duo/DuoSidebar.tsx": "page",
  "library/ExpoLibrary.tsx": "system",
  "search/SearchTray.tsx": "page",
  "search/StartScreen.tsx": "frostable",
  "search/StartSpaces.tsx": "frostable",
  "settings/SettingsKit.tsx": "sheet",
  "sync/ExpoSpaces.tsx": "system",
  "sync/SpacesView.tsx": "sheet",
  "tabs/ArchiveIntervalCard.tsx": "frostable",
  "tabs/ArchiveView.tsx": "sheet",
  "tabs/DeckBottomBar.tsx": "frostable",
  "tabs/DeckCard.tsx": "frostable",
  "tabs/DeckHeader.tsx": "frostable",
  "tabs/ExpoArchive.tsx": "system",
  "tabs/TabDeck.tsx": "frostable",
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".tsx") && !name.includes(".test.") ? [path] : [];
  });
}

const opensMenus = (source: string) => /<(MenuTrigger|FloatingMenu|Menu)\b/.test(source);

function menuTags(source: string): string[] {
  const tags: string[] = [];
  for (const start of source.matchAll(/<(MenuTrigger|FloatingMenu|Menu)\b/g)) {
    let depth = 0;
    let at = start.index! + start[0].length;
    for (; at < source.length; at++) {
      const char = source[at];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0 && source[at - 1] !== "=") break;
    }
    tags.push(source.slice(start.index!, at + 1));
  }
  return tags;
}

test("every place that opens a menu is listed with what it floats over, so a new one has to choose its material", () => {
  const found = sources(COMPONENTS)
    .map((file) => relative(COMPONENTS, file))
    .filter((file) => !["ui/Menu.tsx", "ui/MenuTrigger.tsx"].includes(file) && opensMenus(readFileSync(join(COMPONENTS, file), "utf8")))
    .sort();
  assert.deepEqual(found, Object.keys(SITES).sort());
});

test("every drawn menu over a page or the Reader is opaque, since a WebView can't be frosted and would show sharp through the panel", () => {
  const frosted = Object.entries(SITES)
    .filter(([, over]) => over === "page")
    .filter(([file]) => {
      return menuTags(readFileSync(join(COMPONENTS, file), "utf8")).some((tag) => !/frost=\{null\}/.test(tag));
    })
    .map(([file]) => file);
  assert.deepEqual(frosted, []);
});
