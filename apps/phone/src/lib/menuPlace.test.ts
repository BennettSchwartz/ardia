import assert from "node:assert/strict";
import test from "node:test";
import { MENU_DIVIDER, MENU_HEADING, MENU_PADDING, MENU_ROW, menuAt, menuBeside, menuHeight, menuTop, tallestMenuPage } from "./menuPlace.ts";

const host = { x: 0, y: 0, width: 392, height: 873 };

test("a menu opens fully below the row that opened it, or fully above when there is no room", () => {
  const row = { x: 16, y: 300, width: 360, height: 52 };
  assert.equal(menuTop(row, host, 200, 8), 352);
  const low = { x: 16, y: 760, width: 360, height: 52 };
  assert.equal(menuTop(low, host, 200, 8), 560);
  assert.equal(menuTop(row, { ...host, y: 24 }, 200, 8), 328);
});

test("a menu too tall for either side keeps clear of the edges", () => {
  const row = { x: 16, y: 400, width: 360, height: 52 };
  assert.equal(menuTop(row, host, 700, 8), 165);
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

test("a menu beside a row never runs under the system bars", () => {
  const row = { x: 16, y: 700, width: 360, height: 52 };
  assert.deepEqual(menuBeside(row, host, room, 200, 8), { top: 500, below: false });
  assert.deepEqual(menuBeside({ ...row, y: 60 }, host, room, 200, 8), { top: 112, below: true });
});

test("the tallest page of a menu counts a submenu's back row and its children", () => {
  const items = [{ label: "a" }, { label: "Send to Device", children: [{ label: "1" }, { label: "2" }, { label: "3" }] }];
  assert.equal(tallestMenuPage(items), MENU_ROW + MENU_PADDING + MENU_ROW * 3);
});
