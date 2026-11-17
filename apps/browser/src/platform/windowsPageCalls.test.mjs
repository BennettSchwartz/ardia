import assert from "node:assert/strict";
import { test } from "node:test";
import { pageMethod } from "../../../../packages/expo-windows/src/engine/pageCalls.ts";

const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function host(answers = {}) {
  const received = [];
  const call = async (key, method, args) => {
    received.push([key, method, args]);
    const answer = answers[args.action ?? method];
    if (answer instanceof Error) throw answer;
    await later(args.action === "seekTo" ? 30 : 0);
    return answer ?? { ok: true, done: true };
  };
  return { call, received };
}

test("media commands sent without awaiting reach the host in the order they were sent, one after the other", async () => {
  const { call, received } = host();
  const mediaCommand = pageMethod(call, "page-a", "mediaCommand");
  const seek = mediaCommand("seekTo", 20);
  const play = mediaCommand("play");
  await later(5);
  assert.deepEqual(received, [["page-a", "mediaCommand", { action: "seekTo", seconds: 20 }]], "the play waits for the seek's answer");
  await Promise.all([seek, play]);
  assert.deepEqual(
    received.map(([, , args]) => args.action),
    ["seekTo", "play"],
  );
});

test("one page's media commands do not wait for another page's", async () => {
  const { call, received } = host();
  const slow = pageMethod(call, "page-a", "mediaCommand")("seekTo", 20);
  const other = pageMethod(call, "page-b", "mediaCommand")("play");
  await other;
  assert.deepEqual(
    received.map(([key, , args]) => [key, args.action]),
    [
      ["page-a", "seekTo"],
      ["page-b", "play"],
    ],
  );
  await slow;
});

test("a refused media command answers nothing and the next one still goes", async () => {
  const { call, received } = host({ next: new Error("the page's media session does not take that") });
  const mediaCommand = pageMethod(call, "page-c", "mediaCommand");
  const refused = mediaCommand("next");
  const play = mediaCommand("play");
  assert.equal(await refused, null);
  assert.deepEqual(await play, { done: true });
  assert.deepEqual(
    received.map(([, , args]) => args.action),
    ["next", "play"],
  );
});

test("the engine's answer reaches the caller: done false when no session took the command, and byScript for the wake's play", async () => {
  const { call } = host({ play: { ok: true, done: false }, seekTo: { byScript: true, done: true, ok: true } });
  const mediaCommand = pageMethod(call, "page-d", "mediaCommand");
  assert.deepEqual(await mediaCommand("play"), { done: false });
  assert.deepEqual(await mediaCommand("seekTo", 3), { done: true, byScript: true });
});

test("a method the table does not know is left to the caller", () => {
  assert.equal(pageMethod(host().call, "page-e", "notAMethod"), null);
});
