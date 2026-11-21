(function (native) {
  "use strict";
  const g = globalThis;
  const define = (name, value) => Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });
  const forget = g.clearTimeout;
  const cancel = (id) => {
    forget(id);
    native.cancel(Number(id));
  };
  const guarded = (add) => (fn, ms, ...args) => {
    const id = add(fn, ms, ...args);
    if (native.refused(id)) {
      forget(id);
      throw new RangeError(native.tooMany);
    }
    return id;
  };
  define("setTimeout", guarded(g.setTimeout));
  define("setInterval", guarded(g.setInterval));
  define("clearTimeout", cancel);
  define("clearInterval", cancel);
})
