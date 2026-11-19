import XCTest

@testable import ArdiaPluginCore

final class PluginSandboxEscapeTests: XCTestCase {
  static let lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  static let probeSource = """
    #include <errno.h>
    #include <libproc.h>
    #include <servers/bootstrap.h>
    #include <signal.h>
    #include <stdio.h>
    #include <stdlib.h>
    #include <string.h>
    #include <sys/socket.h>
    #include <sys/un.h>
    #include <unistd.h>
    static int failed(void) { int code = errno; printf("errno %d\\n", code); return code ? code : 99; }
    int main(int argc, char **argv) {
      if (argc < 3) return 98;
      const char *mode = argv[1];
      if (!strcmp(mode, "pidpath")) {
        char path[PROC_PIDPATHINFO_MAXSIZE];
        if (proc_pidpath(atoi(argv[2]), path, sizeof path) <= 0) return failed();
        printf("%s\\n", path);
        return 0;
      }
      if (!strcmp(mode, "pidinfo")) {
        struct proc_bsdinfo info;
        if (proc_pidinfo(atoi(argv[2]), PROC_PIDTBSDINFO, 0, &info, sizeof info) != sizeof info) return failed();
        printf("%s\\n", info.pbi_comm);
        return 0;
      }
      if (!strcmp(mode, "signal")) {
        if (kill(atoi(argv[2]), 0) != 0) return failed();
        printf("signalled\\n");
        return 0;
      }
      if (!strcmp(mode, "lookup")) {
        mach_port_t port = MACH_PORT_NULL;
        kern_return_t result = bootstrap_look_up(bootstrap_port, argv[2], &port);
        printf("%s %d\\n", result == KERN_SUCCESS ? "reachable" : "refused", result);
        return result == KERN_SUCCESS ? 0 : 97;
      }
      if (!strcmp(mode, "connect")) {
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        struct sockaddr_un address = {0};
        address.sun_family = AF_UNIX;
        strlcpy(address.sun_path, argv[2], sizeof address.sun_path);
        if (connect(fd, (struct sockaddr *)&address, sizeof address) != 0) return failed();
        printf("connected\\n");
        return 0;
      }
      return 98;
    }
    """

  struct Outcome {
    let status: Int32
    let output: String
  }

  var root = ""
  var home = ""
  var data = ""
  var config = ""
  var plugin = ""
  var pluginData = ""
  var outside = ""
  var token = ""
  var tokenFile = ""
  var probe = ""
  var started: [Process] = []
  var listeners: [Int32] = []
  var scratch: [String] = []
  var preferenceDomains: [String] = []
  var jobs: [String] = []

  override func setUpWithError() throws {
    let made = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pe-\(Self.short())", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    root = PluginSandbox.resolved(made.path)!
    home = "\(root)/home"
    data = "\(root)/data"
    config = "\(data)/config"
    plugin = "\(config)/plugins/example"
    pluginData = "\(data)/PluginData/example"
    outside = "\(root)/o"
    for folder in [home, plugin, "\(pluginData)/home", "\(pluginData)/tmp", "\(data)/Chromium", outside] {
      try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    }
    token = "fake-control-token-\(UUID().uuidString)"
    tokenFile = "\(data)/Chromium/ArdiaControl.json"
    try "{\"token\":\"\(token)\"}".write(toFile: tokenFile, atomically: true, encoding: .utf8)
    try Self.probeSource.write(toFile: "\(root)/probe.c", atomically: true, encoding: .utf8)
    probe = "\(plugin)/probe"
    let built = try Self.run("/usr/bin/xcrun", ["clang", "-O", "-o", probe, "\(root)/probe.c"])
    XCTAssertEqual(built.status, 0, built.output)
  }

  override func tearDownWithError() throws {
    for process in started where process.isRunning { process.terminate() }
    for fd in listeners { close(fd) }
    for job in jobs { _ = try? Self.run("/bin/launchctl", ["remove", job]) }
    let bundles = (try? FileManager.default.contentsOfDirectory(atPath: pluginData))?.filter { $0.hasSuffix(".app") } ?? []
    for bundle in bundles { _ = try? Self.run(Self.lsregister, ["-u", "\(pluginData)/\(bundle)"]) }
    for domain in preferenceDomains {
      _ = try? Self.run("/usr/bin/defaults", ["delete", domain])
      try? FileManager.default.removeItem(atPath: "\(NSHomeDirectory())/Library/Preferences/\(domain).plist")
    }
    for path in scratch { try? FileManager.default.removeItem(atPath: path) }
    try? FileManager.default.removeItem(atPath: root)
  }

  static func short() -> String { String(UUID().uuidString.prefix(8)).lowercased() }

  static func run(_ program: String, _ arguments: [String], in folder: String? = nil) throws -> Outcome {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: program)
    process.arguments = arguments
    if let folder { process.currentDirectoryURL = URL(fileURLWithPath: folder) }
    let pipe = Pipe()
    process.standardInput = FileHandle.nullDevice
    process.standardError = pipe
    process.standardOutput = pipe
    try process.run()
    let output = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return Outcome(status: process.terminationStatus, output: String(decoding: output, as: UTF8.self))
  }

  func sandboxed(_ program: String, _ arguments: [String]) throws -> Outcome {
    let box = PluginSandbox(home: home, appData: data, configFolder: config, pluginFolder: plugin, pluginData: pluginData, program: program, network: true)
    return try Self.run("/usr/bin/sandbox-exec", try box.arguments() + [program] + arguments, in: plugin)
  }

  func shell(_ script: String) throws -> Outcome { try sandboxed("/bin/sh", ["-c", script]) }

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
      "CFBundleExecutable": "run", "CFBundleIdentifier": "dev.ardia.plugin-escape.\(Self.short())", "CFBundlePackageType": "APPL", "LSBackgroundOnly": true,
    ]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: URL(fileURLWithPath: "\(bundle)/Contents/Info.plist"))
    let run = "\(bundle)/Contents/MacOS/run"
    try "#!/bin/sh\ncat '\(tokenFile)' > '\(leak)'\n".write(toFile: run, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: run)
    return bundle
  }

  func listen(at path: String) throws {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    XCTAssertGreaterThanOrEqual(fd, 0)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8CString)
    XCTAssertLessThan(bytes.count, MemoryLayout.size(ofValue: address.sun_path), "\(path) is too long for a socket")
    withUnsafeMutableBytes(of: &address.sun_path) { raw in bytes.withUnsafeBytes { raw.copyMemory(from: $0) } }
    let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    XCTAssertEqual(bound, 0, "bind \(path): \(String(cString: strerror(errno)))")
    XCTAssertEqual(Darwin.listen(fd, 8), 0)
    listeners.append(fd)
  }

  func testTheControlTokenIsUnreadableFromInside() throws {
    XCTAssertEqual(try Self.run("/bin/cat", [tokenFile]).output.contains(token), true, "control: the token is readable outside")
    let inside = try sandboxed("/bin/cat", [tokenFile])
    XCTAssertNotEqual(inside.status, 0)
    XCTAssertFalse(inside.output.contains(token))
  }

  func testAnAppItWritesCannotBeLaunchedOutsideTheSandbox() throws {
    let controlLeak = "\(outside)/control-opened"
    let control = try Self.run("/usr/bin/open", ["-g", "-j", try backgroundApp("Control", writingTo: controlLeak)])
    try XCTSkipUnless(control.status == 0 && leaked(controlLeak, waiting: 10), "LaunchServices can't launch apps here: \(control.output)")
    let leak = "\(outside)/opened"
    let inside = try sandboxed("/usr/bin/open", ["-g", "-j", try backgroundApp("Escape", writingTo: leak)])
    XCTAssertNotEqual(inside.status, 0, "open reports success inside: \(inside.output)")
    XCTAssertFalse(leaked(leak, waiting: 3), "the app ran outside the sandbox and read the control token")
  }

  func testNSWorkspaceCannotLaunchItEither() throws {
    func script(_ bundle: String) -> String {
      "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.openURL($.NSURL.fileURLWithPath('\(bundle)')) ? 'opened' : 'refused'"
    }
    let controlLeak = "\(outside)/control-workspace"
    let control = try Self.run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script(try backgroundApp("WorkspaceControl", writingTo: controlLeak))])
    try XCTSkipUnless(control.output.contains("opened") && leaked(controlLeak, waiting: 10), "NSWorkspace can't launch apps here: \(control.output)")
    let leak = "\(outside)/workspace"
    let inside = try sandboxed("/usr/bin/osascript", ["-l", "JavaScript", "-e", script(try backgroundApp("Workspace", writingTo: leak))])
    XCTAssertTrue(inside.output.contains("refused"), "openURL didn't report a refusal: \(inside.output)")
    XCTAssertFalse(leaked(leak, waiting: 3), "NSWorkspace launched the app outside the sandbox")
  }

  func testProcessesOutsideItCanNotBeSignalledOrInspected() throws {
    let sibling = Process()
    sibling.executableURL = URL(fileURLWithPath: "/bin/sleep")
    sibling.arguments = ["30"]
    try sibling.run()
    started.append(sibling)
    let pid = String(sibling.processIdentifier)
    let expected = ["pidpath": "/bin/sleep", "pidinfo": "sleep", "signal": "signalled"]
    for (mode, answer) in expected {
      let control = try Self.run(probe, [mode, pid])
      XCTAssertEqual(control.status, 0, "control \(mode): \(control.output)")
      XCTAssertTrue(control.output.contains(answer), "control \(mode): \(control.output)")
      let inside = try sandboxed(probe, [mode, pid])
      XCTAssertEqual(inside.status, EPERM, "\(mode) of a process outside: \(inside.output)")
      XCTAssertFalse(inside.output.contains(answer))
    }
    XCTAssertTrue(sibling.isRunning)
    let family = try shell("'\(probe)' pidinfo $$ || exit 1; /bin/sleep 30 & child=$!; /bin/sleep 0.3; '\(probe)' pidpath $child && '\(probe)' signal $child && kill $child")
    XCTAssertEqual(family.status, 0, "it still inspects and signals itself and its children: \(family.output)")
    XCTAssertTrue(family.output.contains("/bin/sleep"))
  }

  func testUnixSocketsOutsideItsFolderAreUnreachable() throws {
    let id = Self.short()
    let launchdLayout = "/private/tmp/com.apple.launchd.ardia\(id)"
    let tempAgent = "/private/tmp/ardia-agent-\(id)"
    scratch += [launchdLayout, tempAgent]
    for folder in [launchdLayout, tempAgent] { try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true) }
    let refused = ["\(launchdLayout)/Listeners", "\(tempAgent)/agent.sock", "\(outside)/agent.sock"]
    let allowed = "\(pluginData)/own.sock"
    for path in refused + [allowed] { try listen(at: path) }
    for path in refused {
      let spellings = [path, path.replacingOccurrences(of: "/private/", with: "/", options: .anchored)]
      for spelling in spellings {
        let control = try Self.run(probe, ["connect", spelling])
        XCTAssertEqual(control.status, 0, "control: \(spelling) accepts outside: \(control.output)")
        let inside = try sandboxed(probe, ["connect", spelling])
        XCTAssertEqual(inside.status, EPERM, "\(spelling) is reachable from inside: \(inside.output)")
      }
    }
    XCTAssertEqual(try sandboxed(probe, ["connect", allowed]).status, 0, "its own folder's sockets still work")
  }

  func testMachServicesOffTheAllowlistAreRefused() throws {
    let denied = ["com.apple.lsd.open", "com.apple.lsd.modifydb", "com.apple.coreservices.launchservicesd", "com.apple.xpc.smd", "com.apple.backgroundtaskmanagement", "com.apple.tccd", "com.apple.pasteboard.1"]
    for name in denied {
      let control = try Self.run(probe, ["lookup", name])
      XCTAssertEqual(control.status, 0, "control: \(name) is reachable outside: \(control.output)")
      let inside = try sandboxed(probe, ["lookup", name])
      XCTAssertNotEqual(inside.status, 0, "\(name) is reachable from inside")
    }
    for name in ["com.apple.trustd.agent", "com.apple.cfprefsd.agent", "com.apple.SystemConfiguration.DNSConfiguration"] {
      XCTAssertEqual(try sandboxed(probe, ["lookup", name]).status, 0, "\(name) is on the allowlist")
    }
  }

  func testAppleEventsAreRefused() throws {
    try XCTSkipUnless(try Self.run("/usr/bin/pgrep", ["-x", "Finder"]).status == 0, "Finder isn't running, so a refusal proves nothing")
    let disk = try XCTUnwrap(try URL(fileURLWithPath: "/").resourceValues(forKeys: [.volumeNameKey]).volumeName)
    let inside = try sandboxed("/usr/bin/osascript", ["-e", "tell application \"Finder\" to get name of startup disk"])
    XCTAssertNotEqual(inside.status, 0)
    XCTAssertTrue(inside.output.contains("execution error"), inside.output)
    XCTAssertFalse(inside.output.contains("\n\(disk)\n") || inside.output.hasPrefix(disk), "Finder answered from inside: \(inside.output)")
  }

  func testLaunchdJobsCannotBeSubmitted() throws {
    let controlJob = "dev.ardia.plugin-escape.control.\(Self.short())"
    let controlLeak = "\(outside)/control-job"
    jobs.append(controlJob)
    let control = try Self.run("/bin/launchctl", ["submit", "-l", controlJob, "--", "/bin/sh", "-c", "cat '\(tokenFile)' > '\(controlLeak)'"])
    try XCTSkipUnless(control.status == 0 && leaked(controlLeak, waiting: 10), "launchd won't run a submitted job here: \(control.output)")
    let job = "dev.ardia.plugin-escape.\(Self.short())"
    let leak = "\(outside)/job"
    jobs.append(job)
    let inside = try sandboxed("/bin/launchctl", ["submit", "-l", job, "--", "/bin/sh", "-c", "cat '\(tokenFile)' > '\(leak)'"])
    XCTAssertNotEqual(inside.status, 0)
    XCTAssertNotEqual(try Self.run("/bin/launchctl", ["list", job]).status, 0, "the job was registered")
    XCTAssertFalse(leaked(leak, waiting: 2))
  }

  func testItCannotWriteOtherAppsPreferences() throws {
    let controlDomain = "dev.ardia.plugin-escape.control.\(Self.short())"
    let domain = "dev.ardia.plugin-escape.\(Self.short())"
    preferenceDomains += [controlDomain, domain]
    XCTAssertEqual(try Self.run("/usr/bin/defaults", ["write", controlDomain, "key", "value"]).status, 0)
    XCTAssertEqual(try Self.run("/usr/bin/defaults", ["read", controlDomain, "key"]).output.trimmingCharacters(in: .whitespacesAndNewlines), "value", "control")
    XCTAssertNotEqual(try sandboxed("/usr/bin/defaults", ["write", domain, "key", "value"]).status, 0)
    XCTAssertNotEqual(try Self.run("/usr/bin/defaults", ["read", domain, "key"]).status, 0)
    XCTAssertEqual(try sandboxed("/usr/bin/defaults", ["read", controlDomain, "key"]).output.trimmingCharacters(in: .whitespacesAndNewlines), "value", "reading preferences still works")
  }
}
