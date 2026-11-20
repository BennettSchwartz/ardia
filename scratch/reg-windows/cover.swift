import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let screen = NSScreen.main!.visibleFrame
let w = NSWindow(contentRect: NSRect(x: screen.minX + 40, y: screen.minY + 40, width: screen.width * 0.7, height: screen.height * 0.8), styleMask: [.titled], backing: .buffered, defer: false)
w.title = "reg-windows cover"
w.backgroundColor = NSColor(calibratedRed: 0.2, green: 0.5, blue: 0.3, alpha: 1)
w.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
signal(SIGUSR1) { _ in DispatchQueue.main.async { NSApp.activate(ignoringOtherApps: true); NSApp.windows.first?.makeKeyAndOrderFront(nil) } }
app.run()
