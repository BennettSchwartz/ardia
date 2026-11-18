import assert from "node:assert/strict";
import { test } from "node:test";
const w = await import("./listWindow.ts");

const ROW = 34;
const GAP = 3;
const rows = (n) => w.listGeometry(new Array(n).fill(ROW), GAP);

function drawnTops(g, gap, mounted) {
  const { pieces, after } = w.windowPieces(g, gap, mounted);
  const children = [];
  for (const p of pieces) {
    if (p.before > 0) children.push({ spacer: p.before });
    children.push({ index: p.index, height: g.heights[p.index] });
  }
  if (after > 0) children.push({ spacer: after });
  let y = 0;
  const tops = new Map();
  children.forEach((c, k) => {
    if (k) y += gap;
    if (c.index !== undefined) tops.set(c.index, y);
    y += c.index !== undefined ? c.height : c.spacer;
  });
  return { tops, end: y };
}

test("offsets add each entry's height and the gap between them", () => {
  const g = w.listGeometry([34, 120, 34], GAP);
  assert.deepEqual(g.tops, [0, 37, 160]);
  assert.equal(g.end, 194);
  assert.equal(w.listGeometry([], GAP).end, 0);
});

test("the entries in a band are the ones it overlaps, found by binary search", () => {
  const g = rows(300);
  assert.deepEqual(w.entriesIn(g, { top: 0, bottom: 800 }), [0, 22]);
  assert.deepEqual(w.entriesIn(g, { top: 37 * 100 + 10, bottom: 37 * 100 + 20 }), [100, 101]);
  assert.deepEqual(w.entriesIn(g, { top: 35, bottom: 37 }), [1, 1], "the gap belongs to no row");
  assert.deepEqual(w.entriesIn(g, { top: -800, bottom: -10 }), [0, 0]);
  assert.deepEqual(w.entriesIn(g, { top: 1e6, bottom: 1e6 + 800 }), [300, 300]);
});

test("the window keeps one screen above and two below, and moves only when the view nears its edge", () => {
  const view = { top: 1000, bottom: 1800 };
  const first = w.nextWindow(null, view, 2400);
  assert.deepEqual(first, { top: 200, bottom: 3400 });
  assert.equal(w.nextWindow(first, { top: 1300, bottom: 2100 }, 2400), first, "a short scroll keeps it");
  assert.equal(w.nextWindow(first, { top: 600, bottom: 1400 }, 2400), first, "half a screen up keeps it");
  assert.deepEqual(w.nextWindow(first, { top: 1900, bottom: 2700 }, 2400), { top: 1100, bottom: 4300 }, "past the slack it re-centres");
  assert.deepEqual(w.nextWindow(first, { top: 500, bottom: 1300 }, 2400), { top: -300, bottom: 2900 });
  assert.deepEqual(w.nextWindow(null, null, 2400), { top: 0, bottom: 2400 }, "before the scroll view is laid out, the first paint's height");
  assert.equal(w.nextWindow(first, null, 2400), first);
});

test("kept entries mount wherever they are, and spacers keep every mounted entry at its true offset", () => {
  const g = w.listGeometry([34, 34, 200, 34, 34, 34, 34, 34, 34, 34], GAP);
  const mounted = w.mountedIndices(g, { top: g.tops[3], bottom: g.tops[5] + 1 }, [0, 8, 42]);
  assert.deepEqual(mounted, [0, 3, 4, 5, 8]);
  const drawn = drawnTops(g, GAP, mounted);
  for (const i of mounted) assert.equal(drawn.tops.get(i), g.tops[i], `entry ${i}`);
  assert.equal(drawn.end, g.end, "the list keeps its full height");
});

test("with nothing mounted one spacer holds the list's height, and an empty list draws nothing", () => {
  const g = rows(50);
  assert.deepEqual(w.windowPieces(g, GAP, []), { pieces: [], after: g.end });
  assert.equal(drawnTops(g, GAP, []).end, g.end);
  assert.deepEqual(w.windowPieces(rows(0), GAP, []), { pieces: [], after: 0 });
});

test("a window at the end or the start of the list needs no spacer on that side", () => {
  const g = rows(40);
  const end = w.mountedIndices(g, { top: g.tops[35], bottom: g.end + 500 }, []);
  assert.equal(end.at(-1), 39);
  assert.equal(w.windowPieces(g, GAP, end).after, 0);
  const start = w.mountedIndices(g, { top: -400, bottom: 100 }, []);
  assert.equal(w.windowPieces(g, GAP, start).pieces[0].before, 0);
  for (const mounted of [end, start]) {
    const drawn = drawnTops(g, GAP, mounted);
    for (const i of mounted) assert.equal(drawn.tops.get(i), g.tops[i]);
    assert.equal(drawn.end, g.end);
  }
});

test("a row slot stays with its entry while it stays mounted, whatever the count, and freed slots go to new entries", () => {
  let slots = w.keepSlots(["a", "b", "c", "d"], new Map());
  assert.deepEqual([...slots], [["a", 0], ["b", 1], ["c", 2], ["d", 3]]);
  slots = w.keepSlots(["d", "e"], slots);
  assert.equal(slots.get("d"), 3, "a kept entry keeps a slot above the new count");
  assert.equal(slots.get("e"), 0);
  slots = w.keepSlots(["e", "f", "g", "d"], slots);
  assert.deepEqual([...slots].sort((x, y) => x[1] - y[1]), [["e", 0], ["f", 1], ["g", 2], ["d", 3]]);
});

test("while a drag runs the window holds three screens each way, so an edge auto-scroll finds rows already drawn", () => {
  const view = { top: 1000, bottom: 1800 };
  assert.deepEqual(w.nextWindow(null, view, 2400, true), { top: -1400, bottom: 4200 });
  const plain = w.nextWindow(null, view, 2400);
  assert.notEqual(w.nextWindow(plain, view, 2400, true), plain, "a drag starting widens the window at once");
});

test("scrolling up puts the two screens above, and only a quarter screen the other way turns the window round", () => {
  const view = { top: 5000, bottom: 5800 };
  assert.deepEqual(w.nextWindow(null, view, 2400, false, true), { top: 3400, bottom: 6600 });
  const down = w.nextWindow(null, view, 2400);
  assert.equal(w.nextWindow(down, { top: 4700, bottom: 5500 }, 2400, false, false), down, "a short way back up keeps the window");
  assert.deepEqual(w.nextWindow(down, { top: 4700, bottom: 5500 }, 2400, false, true), { top: 3100, bottom: 6300 }, "heading up it needs a whole screen above");
  let travel = { up: false, turn: 0 };
  for (const top of [100, 900, 5000]) travel = w.travelAfter(travel, { top, bottom: top + 800 });
  assert.deepEqual(travel, { up: false, turn: 5000 });
  travel = w.travelAfter(travel, { top: 4850, bottom: 5650 });
  assert.equal(travel.up, false, "150 pt back is a wobble");
  travel = w.travelAfter(travel, { top: 4790, bottom: 5590 });
  assert.deepEqual(travel, { up: true, turn: 4790 });
  travel = w.travelAfter(travel, { top: 4000, bottom: 4800 });
  travel = w.travelAfter(travel, { top: 4150, bottom: 4950 });
  assert.deepEqual(travel, { up: true, turn: 4000 });
  travel = w.travelAfter(travel, { top: 4201, bottom: 5001 });
  assert.equal(travel.up, false);
});

test("a row about to be scrolled to mounts with the screens the list crosses to reach it, beside the window", () => {
  const g = rows(500);
  const view = { top: 0, bottom: 800 };
  assert.equal(w.arrivalSide(g, 400, view), 1);
  assert.equal(w.arrivalSide(g, 5, view), 0, "a row in view needs nothing");
  assert.equal(w.arrivalSide(g, 5, { top: 9000, bottom: 9800 }), -1);
  assert.equal(w.arrivalSide(g, -1, view), 0);
  const arrival = w.arrivalBand(g, 400, 800, 1);
  assert.deepEqual(arrival, { top: g.tops[400] - 1800, bottom: g.tops[400] + ROW + 200 });
  assert.deepEqual(w.arrivalBand(g, 400, 800, -1), { top: g.tops[400] - 200, bottom: g.tops[400] + ROW + 1800 });
  assert.equal(w.arrivalBand(g, 400, 800, 0), null);
  assert.equal(w.arrivalBand(g, -1, 800, 1), null);
  assert.equal(w.arrivalBand(g, 400, 0, 1), null);
  const mounted = w.mountedIndices(g, [view, arrival, null], [3]);
  assert.equal(mounted[0], 0);
  assert.ok(mounted.includes(21) && !mounted.includes(23));
  assert.ok(mounted.includes(400) && mounted.includes(352) && !mounted.includes(350) && !mounted.includes(407));
  const drawn = drawnTops(g, GAP, mounted);
  for (const i of mounted) assert.equal(drawn.tops.get(i), g.tops[i]);
  assert.equal(drawn.end, g.end);
});

test("a surviving row is never re-inserted: a freed slot goes only to a new row that sits after every row drawn before the slot's old place", () => {
  const moved = (was, now) => {
    const place = new Map([...was.values()].map((slot, i) => [slot, i]));
    let last = -1;
    const out = [];
    for (const [key, slot] of now) {
      const old = place.get(slot);
      if (old === undefined) continue;
      if (old < last) out.push(key);
      else last = old;
    }
    return out;
  };
  const down = w.keepSlots(["a", "b", "c", "d", "e", "f"], new Map());
  const after = w.keepSlots(["d", "e", "f", "g", "h", "i"], down);
  assert.deepEqual([...after.values()], [3, 4, 5, 0, 1, 2], "scrolling down hands the rows that left to the rows that arrive");
  assert.deepEqual(moved(down, after), ["g", "h", "i"], "only the recycled rows move");
  const up = w.keepSlots(["a", "b", "c", "d", "e"], after);
  assert.deepEqual(moved(after, up).filter((k) => ["d", "e"].includes(k)), [], "scrolling up leaves the rows that stay where they are");
  assert.equal(new Set(up.values()).size, 5);
  const renaming = w.keepSlots(["r", "x", "y", "z"], new Map());
  const back = w.keepSlots(["p", "q", "r", "s"], renaming);
  assert.deepEqual(moved(renaming, back).filter((k) => k === "r"), [], "a kept row far above keeps its native view when the list scrolls back to it");
  assert.equal(back.get("r"), renaming.get("r"));
});

test("while the list glides fast to a tab the window stays put until the view passes the rows mounted for it", () => {
  const band = { top: -800, bottom: 2400 };
  const arrival = { top: 9000, bottom: 10634 };
  const FAST = 400;
  assert.equal(w.holdsForArrival({ top: 0, bottom: 800 }, band, null, FAST), false);
  assert.equal(w.holdsForArrival({ top: 4000, bottom: 4800 }, band, arrival, FAST), true, "on the way");
  assert.equal(w.holdsForArrival({ top: 4000, bottom: 4800 }, band, arrival, 40), false, "a slow scroll between the two gets its rows");
  assert.equal(w.holdsForArrival({ top: 8600, bottom: 9400 }, band, arrival, FAST), true, "entering");
  assert.equal(w.holdsForArrival({ top: 9400, bottom: 10200 }, band, arrival, 2), true, "there, slowing down");
  assert.equal(w.holdsForArrival({ top: 10400, bottom: 11200 }, band, arrival, FAST), false, "scrolled past it");
  assert.equal(w.holdsForArrival({ top: -1500, bottom: -700 }, band, arrival, FAST), false, "scrolled the other way");
  const above = { top: 100, bottom: 1734 };
  const low = { top: 8000, bottom: 11200 };
  assert.equal(w.holdsForArrival({ top: 5000, bottom: 5800 }, low, above, FAST), true);
  assert.equal(w.holdsForArrival({ top: 11500, bottom: 12300 }, low, above, FAST), false);
});

test("the faster the list moves, the further ahead of it rows are drawn", () => {
  assert.equal(w.runwayScreens(40, 16, 800), 40 / 16 * 1000 * 0.15 / 800);
  assert.equal(w.runwayScreens(-400, 16, 800), 4, "at most four screens");
  assert.equal(w.runwayScreens(400, 0, 800), 0);
  const view = { top: 5000, bottom: 5800 };
  const slow = w.nextWindow(null, view, 2400, false, false, 0.4);
  assert.deepEqual(slow, { top: 4200, bottom: 7400 }, "a slow scroll keeps the usual two screens");
  const fast = w.nextWindow(null, view, 2400, false, false, 3);
  assert.deepEqual(fast, { top: 4200, bottom: 9000 }, "three screens of runway and one to spare");
  assert.equal(w.nextWindow(fast, { top: 5700, bottom: 6500 }, 2400, false, false, 3), fast);
  assert.deepEqual(w.nextWindow(fast, { top: 5900, bottom: 6700 }, 2400, false, false, 3), { top: 5100, bottom: 9900 }, "it moves on while three screens are still drawn ahead");
  assert.deepEqual(w.nextWindow(null, view, 2400, false, true, 3), { top: 1800, bottom: 6600 }, "upwards the runway is above");
});
