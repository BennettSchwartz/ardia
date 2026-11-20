import CoreGraphics
let s = CGEventSource(stateID: .hidSystemState)
for d in [true, false] { CGEvent(keyboardEventSource: s, virtualKey: 53, keyDown: d)!.post(tap: .cghidEventTap) }
