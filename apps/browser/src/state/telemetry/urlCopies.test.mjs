import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));
const { noteSelectedTabUrlsCopied, noteUrlCopied, takeUrlCopyCounts } = await import("./urlCopies.ts");

test("address copies are counted, those taken before the first page apart, and taking them starts over", () => {
  noteUrlCopied(false);
  noteUrlCopied(true);
  noteUrlCopied(true);
  noteSelectedTabUrlsCopied();
  assert.deepEqual(takeUrlCopyCounts(), { url_copies: 4, url_copies_while_pending: 2, url_copies_of_selected_tabs: 1 });
  assert.deepEqual(takeUrlCopyCounts(), { url_copies: 0, url_copies_while_pending: 0, url_copies_of_selected_tabs: 0 });
});
