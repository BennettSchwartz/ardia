(function (native) {
  "use strict";
  const g = globalThis;
  const define = (name, value) => Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });
  const forget = g.clearTimeout;
  const cancel = (id) => {
    const key = Number(id);
    forget(key);
    native.cancel(key);
  };
  const calledByFetchLaunch = () => {
    const frames = String(new Error().stack).split("\n").filter((line) => line.trim() !== "" && !line.includes("ardia://plugin-host/timer-cancel.js"));
    return frames.length > 0 && frames[0].includes("ardia://plugin-host/prelude.js") && /\bat launch \(/.test(frames[0]);
  };
  const guarded = (add) => (fn, ms, ...args) => {
    const id = add(fn, ms, ...args);
    if (!native.refused(id)) return id;
    forget(id);
    if (calledByFetchLaunch()) {
      native.refuseNextSend();
      return 0;
    }
    throw new RangeError(native.tooMany);
  };
  define("setTimeout", guarded(g.setTimeout));
  define("setInterval", guarded(g.setInterval));
  define("clearTimeout", cancel);
  define("clearInterval", cancel);
})
