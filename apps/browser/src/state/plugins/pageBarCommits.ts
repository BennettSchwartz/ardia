import { reportPageCommits } from "../../platform/tabs";
import { activeManifest, activeNames, currentPlugins, usePlugins, type PluginsStore } from "./store";

let wanted = false;
let watching = false;

const wantsCommits = (s: Pick<PluginsStore, "listings" | "records" | "order">) => activeNames(s).some((name) => activeManifest(s, name)?.pageBar);

function apply() {
  const want = wantsCommits(currentPlugins());
  if (want === wanted) return;
  wanted = want;
  void reportPageCommits("pageBars", want).catch(() => {});
}

export function watchPageBarCommits() {
  if (watching) return;
  watching = true;
  usePlugins.subscribe(apply);
  apply();
}
