import assert from "node:assert/strict";
import test from "node:test";
import { MENU_DIVIDER, MENU_HEADING, MENU_PADDING, MENU_ROW, menuAt, menuHeight, menuOnTrigger, tallestMenuPage } from "./menuPlace.ts";

const host = { x: 0, y: 0, width: 392, height: 873 };

test("a tap menu's corner sits on its trigger's matching corner and covers it: top-right on the ··· near the right edge, top-left on a button near the left", () => {
  const more = { x: 336, y: 66, width: 44, height: 44 };
  assert.deepEqual(menuOnTrigger(more, host, host, 250, 272, 8), { left: 130, top: 66, origin: "right top" });
  const left = { x: 16, y: 66, width: 120, height: 44 };
  assert.deepEqual(menuOnTrigger(left, host, host, 250, 272, 8), { left: 16, top: 66, origin: "left top" });
});

test("with no room below, a tap menu opens upward with its bottom on the trigger's bottom", () => {
  const picker = { x: 270, y: 700, width: 100, height: 26 };
  assert.deepEqual(menuOnTrigger(picker, host, host, 250, 314, 8), { left: 120, top: 412, origin: "right bottom" });
});

test("a menu too tall for either way keeps clear of the edges, and the host's origin is taken off", () => {
  const row = { x: 16, y: 400, width: 360, height: 52 };
  assert.equal(menuOnTrigger(row, host, host, 250, 900, 8).top, 8);
  assert.equal(menuOnTrigger({ x: 16, y: 300, width: 100, height: 40 }, { ...host, y: 24 }, { ...host, y: 24 }, 250, 200, 8).top, 276);
});

test("a menu's height counts its rows, headings and dividers", () => {
  assert.equal(menuHeight([{ heading: "Archive" }, { label: "a" }, { label: "b" }, "divider", { label: "c" }]), MENU_PADDING + MENU_HEADING + MENU_ROW * 3 + MENU_DIVIDER);
});

const room = { x: 0, y: 40, width: 392, height: 793 };

test("a long-press menu opens at the finger, down and to the right when it fits", () => {
  assert.deepEqual(menuAt({ x: 60, y: 300 }, host, room, 250, 200, 8), { left: 60, top: 300, origin: "left top" });
});

test("near the right or bottom edge it opens back toward the screen from the finger", () => {
  assert.deepEqual(menuAt({ x: 340, y: 760 }, host, room, 250, 200, 8), { left: 90, top: 560, origin: "right bottom" });
});

test("a menu wider or taller than the room left keeps clear of the bars and the screen's edges", () => {
  const spot = menuAt({ x: 5, y: 50 }, host, room, 250, 790, 8);
  assert.equal(spot.left, 8);
  assert.equal(spot.top, 48);
});

test("a tap menu never runs under the system bars", () => {
  const button = { x: 346, y: 760, width: 44, height: 44 };
  assert.deepEqual(menuOnTrigger(button, host, room, 250, 200, 8), { left: 134, top: 604, origin: "right bottom" });
  assert.equal(menuOnTrigger({ ...button, y: 20 }, host, room, 250, 200, 8).top, 48);
});

test("the tallest page of a menu counts a submenu's back row and its children", () => {
  const items = [{ label: "a" }, { label: "Send to Device", children: [{ label: "1" }, { label: "2" }, { label: "3" }] }];
  assert.equal(tallestMenuPage(items), MENU_ROW + MENU_PADDING + MENU_ROW * 3);
});
