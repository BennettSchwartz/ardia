import assert from "node:assert/strict";
import { test } from "node:test";

const { backgroundFill } = await import("../../../../packages/expo-windows/src/views/backgroundFill.ts");

test("no fill without a meaningful background, so the view is left as it is", () => {
  assert.equal(backgroundFill({}), null);
  assert.equal(backgroundFill({ backgroundColor: "transparent", borderRadius: 8 }), null);
});

test("the fill covers the view inside its borders and follows its corners", () => {
  assert.deepEqual(backgroundFill({ backgroundColor: "#123456", borderRadius: 10 }), { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "#123456", borderRadius: 10 });
  assert.deepEqual(backgroundFill({ backgroundColor: "red", borderWidth: 2, borderTopWidth: 3, borderRadius: 10, borderTopLeftRadius: 2 }), {
    position: "absolute",
    top: 3,
    bottom: 2,
    left: 2,
    right: 2,
    backgroundColor: "red",
    borderRadius: 7,
    borderTopLeftRadius: 0,
  });
  assert.equal(backgroundFill({ backgroundColor: "red", borderStartWidth: 4 }).left, 4);
  assert.equal(backgroundFill({ backgroundColor: "red", borderCurve: "continuous" }).borderCurve, "continuous");
});
