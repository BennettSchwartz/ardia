import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
const { usePages, patchPage } = await import("../tabs/pageState.ts");
const { useMedia } = await import("./media.ts");
const { useTabShared, noteTabShare } = await import("./screenShare.ts");

function countingPageSubscriptions() {
  const original = usePages.subscribe;
  let live = 0;
  usePages.subscribe = (listener) => {
    live++;
    const unsubscribe = original(listener);
    return () => {
      live--;
      unsubscribe();
    };
  };
  return { live: () => live, restore: () => (usePages.subscribe = original) };
}

test("a tab row's shared badge watches no page while nothing is shared, and lights up once its tab is shared", () => {
  useMedia.setState({ tabShares: {} });
  const pages = countingPageSubscriptions();
  try {
    const hook = mount(() => useTabShared("shared-tab"));
    assert.equal(hook.value, false);
    assert.equal(pages.live(), 0, "no page subscription per row while no tab shares its screen");
    patchPage("capturer", { mediaAccess: { camera: false, microphone: false, screen: true } });
    noteTabShare("capturer", "shared-tab", "https://meet.example");
    assert.equal(hook.value, true);
    assert.equal(pages.live(), 1, "the row watches pages only while a share names its tab");
    useMedia.setState({ tabShares: {} });
    assert.equal(hook.value, false);
    assert.equal(pages.live(), 0);
    hook.unmount();
  } finally {
    pages.restore();
    patchPage("capturer", { mediaAccess: null });
  }
});
