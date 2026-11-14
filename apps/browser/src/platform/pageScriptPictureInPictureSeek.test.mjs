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
const sessionTimeline = define("sessionTimeline", /const sessionTimeline = (\(state, elapsedSeconds, advancing\) => \{[\s\S]*?\n {2}\});\n/);
const seekByCall = define("seekByCall", /const seekByCall = (\(seconds, el, registered, timeline\) => \{[\s\S]*?\n {2}\});\n/);

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

test("with no element, no relative handler and no reported position nothing is seeked: the current time is unknown, so seekto gets no guess", () => {
  assert.equal(seekByCall(10, null, page("seekto")), null);
  assert.equal(seekByCall(10, null, page("seekto"), null), null);
  assert.equal(seekByCall(-10, null, page("seekforward")), null);
});

test("a page that reports its own timeline gets seekto on that timeline, not the element's", () => {
  const timeline = { position: 620, duration: 3600 };
  assert.deepEqual(seekByCall(10, video(20), page("seekto"), timeline), ["seekto", { seekTime: 630 }]);
  assert.deepEqual(seekByCall(-10, video(20), page("seekto"), timeline), ["seekto", { seekTime: 610 }]);
  assert.deepEqual(seekByCall(10, video(20), page("seekto"), { position: 3595, duration: 3600 }), ["seekto", { seekTime: 3600 }]);
  assert.deepEqual(seekByCall(-10, video(20), page("seekto"), { position: 4, duration: 3600 }), ["seekto", { seekTime: 0 }]);
  assert.deepEqual(seekByCall(10, video(20), page("seekto"), { position: 620, duration: Infinity }), ["seekto", { seekTime: 630 }]);
});

test("the reported timeline reaches a video the page hides in a closed shadow root", () => {
  assert.deepEqual(seekByCall(10, null, page("seekto"), { position: 620, duration: 3600 }), ["seekto", { seekTime: 630 }]);
});

test("the reported timeline is the page's handlers' only: with no handler the element is seeked on its own time", () => {
  assert.deepEqual(seekByCall(10, video(20), page(), { position: 620, duration: 3600 }), ["currentTime", { seekTime: 30 }]);
  assert.deepEqual(seekByCall(10, video(20), page("seekforward"), { position: 620, duration: 3600 }), ["seekforward", { seekOffset: 10 }]);
});

test("the session's position runs on from the last report at its rate while playing, and stands still while paused", () => {
  const reported = { position: 620, duration: 3600, playbackRate: 2 };
  assert.deepEqual(sessionTimeline(reported, 0, true), { position: 620, duration: 3600 });
  assert.deepEqual(sessionTimeline(reported, 1.5, true), { position: 623, duration: 3600 });
  assert.deepEqual(sessionTimeline(reported, 1.5, false), { position: 620, duration: 3600 });
  assert.deepEqual(sessionTimeline({ position: 620, duration: 3600 }, 1.5, true), { position: 621.5, duration: 3600 });
  assert.deepEqual(sessionTimeline({ duration: 3600 }, 1.5, true), { position: 1.5, duration: 3600 });
  assert.deepEqual(sessionTimeline({ position: 3599, duration: 3600 }, 5, true), { position: 3600, duration: 3600 });
  assert.deepEqual(sessionTimeline({ position: 5, duration: 3600, playbackRate: -2 }, 5, true), { position: 0, duration: 3600 });
});

test("a page that reported no position, or cleared it, has no session timeline", () => {
  assert.equal(sessionTimeline(null, 1, true), null);
  assert.equal(sessionTimeline({}, 1, true), null);
});
