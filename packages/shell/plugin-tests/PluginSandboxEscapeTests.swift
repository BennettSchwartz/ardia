import XCTest

@testable import ArdiaPluginCore

final class PluginSandboxEscapeTests: XCTestCase {
  static let lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

  var root = ""
  var home = ""
  var data = ""
  var config = ""
  var plugin = ""
  var pluginData = ""
  var outside = ""
  var token = ""
  var tokenFile = ""
  var preferenceDomain = ""
  var started: [Process] = []

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("plugin-escape-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    root = PluginSandbox.resolved(made.path)!
    home = "\(root)/home"
    data = "\(root)/data"
    config = "\(data)/config"
    plugin = "\(config)/plugins/example"
    pluginData = "\(data)/PluginData/example"
    outside = "\(root)/outside"
    for folder in [home, plugin, "\(pluginData)/home", "\(pluginData)/tmp", "\(data)/Chromium", outside] {
      try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    }
    token = "fake-control-token-\(UUID().uuidString)"
    tokenFile = "\(data)/Chromium/ArdiaControl.json"
    try "{\"token\":\"\(token)\"}".write(toFile: tokenFile, atomically: true, encoding: .utf8)
    preferenceDomain = "dev.ardia.plugin-escape.\(UUID().uuidString)"
  }

  override func tearDownWithError() throws {
    for process in started where process.isRunning { process.terminate() }
    let bundles = (try? FileManager.default.contentsOfDirectory(atPath: pluginData))?.filter { $0.hasSuffix(".app") } ?? []
    for bundle in bundles { _ = try? Self.execute(Self.lsregister, ["-u", "\(pluginData)/\(bundle)"]) }
    _ = try? Self.execute("/usr/bin/defaults", ["delete", preferenceDomain])
    try? FileManager.default.removeItem(atPath: "\(NSHomeDirectory())/Library/Preferences/\(preferenceDomain).plist")
    try? FileManager.default.removeItem(atPath: root)
  }

  @discardableResult
  static func execute(_ program: String, _ arguments: [String], in folder: String? = nil) throws -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: program)
    process.arguments = arguments
    if let folder { process.currentDirectoryURL = URL(fileURLWithPath: folder) }
    process.standardInput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
  }

  func sandboxed(_ script: String) throws -> Int32 {
    let box = PluginSandbox(home: home, appData: data, configFolder: config, pluginFolder: plugin, pluginData: pluginData, program: "/bin/sh", network: false)
    return try Self.execute("/usr/bin/sandbox-exec", try box.arguments() + ["/bin/sh", "-c", script], in: plugin)
  }

  func leaked(_ file: String, waiting seconds: Double) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    repeat {
      if let text = try? String(contentsOfFile: file, encoding: .utf8), text.contains(token) { return true }
      Thread.sleep(forTimeInterval: 0.1)
    } while Date() < deadline
    return false
  }

  func backgroundApp(_ name: String, writingTo leak: String) throws -> String {
    let bundle = "\(pluginData)/\(name).app"
    try FileManager.default.createDirectory(atPath: "\(bundle)/Contents/MacOS", withIntermediateDirectories: true)
    let info: [String: Any] = [
      "CFBundleExecutable": "run", "CFBundleIdentifier": "dev.ardia.plugin-escape.\(UUID().uuidString)", "CFBundlePackageType": "APPL", "LSBackgroundOnly": true,
    ]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: URL(fileURLWithPath: "\(bundle)/Contents/Info.plist"))
    let run = "\(bundle)/Contents/MacOS/run"
    try "#!/bin/sh\ncat '\(tokenFile)' > '\(leak)'\n".write(toFile: run, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: run)
    return bundle
  }

  func testTheControlTokenIsUnreadableFromInside() throws {
    XCTAssertNotEqual(try sandboxed("cat '\(tokenFile)' > '\(pluginData)/copy'"), 0)
    XCTAssertFalse(leaked("\(pluginData)/copy", waiting: 0))
  }

  func testAnAppItWritesCannotBeLaunchedOutsideTheSandbox() throws {
    let leak = "\(outside)/opened"
    let bundle = try backgroundApp("Escape", writingTo: leak)
    let status = try sandboxed("/usr/bin/open -g -j '\(bundle)'")
    XCTAssertNotEqual(status, 0, "open is refused")
    XCTAssertFalse(leaked(leak, waiting: status == 0 ? 5 : 0.5), "the app ran outside the sandbox and read the control token")
  }

  func testNSWorkspaceCannotLaunchItEither() throws {
    let leak = "\(outside)/workspace"
    let bundle = try backgroundApp("Workspace", writingTo: leak)
    let script = "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.openURL($.NSURL.fileURLWithPath('\(bundle)'))"
    try sandboxed("/usr/bin/osascript -l JavaScript -e \"\(script)\"")
    XCTAssertFalse(leaked(leak, waiting: 2), "NSWorkspace launched the app outside the sandbox")
  }

  func testProcessesOutsideItCanNotBeSignalledOrInspected() throws {
    let sibling = Process()
    sibling.executableURL = URL(fileURLWithPath: "/bin/sleep")
    sibling.arguments = ["30"]
    try sibling.run()
    started.append(sibling)
    let pid = sibling.processIdentifier
    XCTAssertNotEqual(try sandboxed("kill -0 \(pid)"), 0, "signals reach a process outside")
    XCTAssertNotEqual(try sandboxed("/usr/sbin/lsof -p \(pid) | grep -q sleep"), 0, "proc_pidinfo reads a process outside")
    XCTAssertTrue(sibling.isRunning)
    XCTAssertEqual(try sandboxed("kill -0 $$ || exit 1; /bin/sleep 30 & child=$!; kill -0 $child && kill $child"), 0, "it still signals itself and its children")
  }

  static func launchdListeners() -> [String] {
    ["/private/var/run", "/private/tmp"].flatMap { folder in
      ((try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []).filter { $0.hasPrefix("com.apple.launchd.") }.map { "\(folder)/\($0)/Listeners" }
    }.filter { FileManager.default.fileExists(atPath: $0) }
  }

  func testTheSshAgentIsUnreachable() throws {
    let cantConnect: Int32 = 2
    let listeners = Self.launchdListeners().filter { (try? Self.execute("/usr/bin/env", ["SSH_AUTH_SOCK=\($0)", "/usr/bin/ssh-add", "-l"])) != cantConnect }
    try XCTSkipIf(listeners.isEmpty, "no ssh-agent listens on a launchd socket here")
    for listener in listeners {
      for spelling in [listener, listener.replacingOccurrences(of: "/private/var/run/", with: "/var/run/", options: .anchored)] {
        XCTAssertEqual(try sandboxed("SSH_AUTH_SOCK='\(spelling)' /usr/bin/ssh-add -l"), cantConnect, "the ssh-agent at \(spelling) answers from inside")
      }
    }
  }

  func testItCannotWriteOtherAppsPreferences() throws {
    XCTAssertNotEqual(try sandboxed("/usr/bin/defaults write '\(preferenceDomain)' key value"), 0)
    XCTAssertNotEqual(try Self.execute("/usr/bin/defaults", ["read", preferenceDomain, "key"]), 0)
  }
}
