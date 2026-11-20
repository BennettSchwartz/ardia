import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1])!
let code = CGKeyCode(UInt16(CommandLine.arguments[2])!)
var flags: CGEventFlags = []
for c in (CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "") {
  switch c { case "c": flags.insert(.maskCommand); case "s": flags.insert(.maskShift); case "o": flags.insert(.maskAlternate); case "t": flags.insert(.maskControl); default: break }
}
let src = CGEventSource(stateID: .privateState)
for down in [true, false] {
  let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)!
  e.flags = flags
  e.postToPid(pid)
  usleep(30000)
}
