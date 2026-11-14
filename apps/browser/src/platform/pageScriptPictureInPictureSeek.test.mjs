import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../../../../packages/ardiacore/ios/page_script.js", import.meta.url), "utf8");
const define = (name, pattern) => {
  const source = script.match(pattern)?.[1];
  assert.ok(source, `page_script.js defines ${name}`);
  return new Function(`return ${source}`)();
};
const pictureInPictureMedia = define("pictureInPictureMedia", /const pictureInPictureMedia = (\(root\) => \{[\s\S]*?\n {2}\});\n/);
const mediaCommandTarget = define("mediaCommandTarget", /const mediaCommandTarget = (\(action, inPictureInPicture, pick\) => \{[\s\S]*?\n {2}\});\n/);

const seekByCall = define("seekByCall", /const seekByCall = (\(seconds, el, registered\) => \{[\s\S]*?\n {2}\});\n/);

const video = (currentTime) => ({ currentTime });
const page = (...names) => (name) => names.includes(name);

test("a Picture in Picture skip seeks the video in the window, not the one the page is playing", () => {
  const inWindow = video(60), playing = video(20);
  assert.deepEqual(mediaCommandTarget("seekPictureInPictureBy", inWindow, () => playing), { action: "seekBy", el: inWindow });
});

test("a frame with nothing in Picture in Picture ignores the skip, so only the window's frame seeks", () => {
  let picked = 0;
  assert.equal(mediaCommandTarget("seekPictureInPictureBy", null, () => (picked++, video(20))), null);
  assert.equal(picked, 0);
});

test("every other media command keeps the page's own pick, even with a video in Picture in Picture", () => {
  const inWindow = video(60), playing = video(20);
  for (const action of ["seekBy", "seekTo", "toggle", "pause"]) assert.deepEqual(mediaCommandTarget(action, inWindow, () => playing), { action, el: playing });
});

test("a video inside open shadow roots is found through its hosts", () => {
  const inWindow = video(60);
  const inner = { shadowRoot: { pictureInPictureElement: inWindow } };
  const outer = { shadowRoot: { pictureInPictureElement: inner } };
  assert.equal(pictureInPictureMedia({ pictureInPictureElement: outer }), inWindow);
  assert.equal(pictureInPictureMedia({ pictureInPictureElement: inWindow }), inWindow);
  assert.equal(pictureInPictureMedia({ pictureInPictureElement: null }), null);
});

test("a closed shadow root hides the video: the skip seeks no element, neither the host nor another video the page plays", () => {
  const host = { shadowRoot: null };
  let picked = 0;
  assert.equal(pictureInPictureMedia({ pictureInPictureElement: host }), host);
  assert.deepEqual(mediaCommandTarget("seekPictureInPictureBy", host, () => (picked++, video(20))), { action: "seekBy", el: null });
  assert.equal(picked, 0);
});

test("a skip goes to the page's relative seek handler for its direction when it has one", () => {
  assert.deepEqual(seekByCall(10, video(60), page("seekforward", "seekbackward", "seekto")), ["seekforward", { seekOffset: 10 }]);
  assert.deepEqual(seekByCall(-10, video(60), page("seekforward", "seekbackward", "seekto")), ["seekbackward", { seekOffset: 10 }]);
  assert.deepEqual(seekByCall(10, null, page("seekforward")), ["seekforward", { seekOffset: 10 }]);
});

test("a page with only a seekto handler is asked to seek to the new time instead of having currentTime set behind its back", () => {
  assert.deepEqual(seekByCall(10, video(60), page("seekto")), ["seekto", { seekTime: 70 }]);
  assert.deepEqual(seekByCall(-10, video(60), page("seekto", "seekforward")), ["seekto", { seekTime: 50 }]);
});

test("with no handler the element is seeked, kept inside the media", () => {
  assert.deepEqual(seekByCall(10, video(60), page()), ["currentTime", { seekTime: 70 }]);
  assert.deepEqual(seekByCall(-10, video(4), page()), ["currentTime", { seekTime: 0 }]);
  assert.deepEqual(seekByCall(10, { currentTime: 175, duration: 180 }, page()), ["currentTime", { seekTime: 180 }]);
});

test("with no element and no relative handler nothing is seeked: the current time is unknown, so seekto gets no guess", () => {
  assert.equal(seekByCall(10, null, page("seekto")), null);
  assert.equal(seekByCall(-10, null, page("seekforward")), null);
});
