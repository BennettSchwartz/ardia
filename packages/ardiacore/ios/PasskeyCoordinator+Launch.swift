import AppKit
import CoreServices
import Foundation

extension PasskeyCoordinator {
  static let helperPointer = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/com.ardia.browser.passkey-import/active.json")

  static func configureFromLaunch() {
    let data: String? = ArdiaHost.dataDirectory.isEmpty ? nil : ArdiaHost.dataDirectory
    if let data { lockPath = (data as NSString).appendingPathComponent("passkeys.lock") }
    let coordinator = PasskeyCoordinator.shared
    coordinator.providersChanged = { entries, generation in
      guard let data else { return }
      var seen = Set<String>()
      let groups = entries.filter { seen.insert($0.groupId).inserted }.map { ["id": $0.groupId, "name": $0.groupName] }
      let file = URL(fileURLWithPath: data).appendingPathComponent("passkey-groups.json")
      if let json = try? JSONSerialization.data(withJSONObject: ["generation": generation, "groups": groups]) { try? json.write(to: file, options: .atomic) }
    }
    #if DEBUG
      let launch = LaunchConfig.shared
      if launch.testInstance, launch.testFlag("passkeysTestStore") {
        testStore = PasskeyTestStore()
        coordinator.makeContext = { nil }
        coordinator.verifyOwner = { _, _, done in done(true) }
        coordinator.autoAnswer = launch.testValue("passkeysAnswer")
        coordinator.requiresVisiblePage = false
        return
      }
    #endif
    DispatchQueue.global(qos: .utility).async {
      try? PasskeyCoordinator.defaultStore().recover()
      registerHelper(dataDirectory: data)
    }
  }

  static func registerHelper(dataDirectory: String?) {
    guard #available(macOS 26.0, *) else { return }
    let helper = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/Ardia Passkeys.app")
    guard FileManager.default.fileExists(atPath: helper.path) else { return }
    LSRegisterURL(helper as CFURL, true)
    let appex = helper.appendingPathComponent("Contents/PlugIns/ArdiaPasskeysProvider.appex")
    let pluginkit = Process()
    pluginkit.executableURL = URL(fileURLWithPath: "/usr/bin/pluginkit")
    pluginkit.arguments = ["-a", appex.path]
    try? pluginkit.run()
    pluginkit.waitUntilExit()
    guard let dataDirectory else { return }
    try? FileManager.default.createDirectory(at: helperPointer.deletingLastPathComponent(), withIntermediateDirectories: true)
    if let json = try? JSONSerialization.data(withJSONObject: ["dataDirectory": dataDirectory]) { try? json.write(to: helperPointer, options: .atomic) }
  }
}

extension PasskeyCoordinator {
  static var helperURL: URL { Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/Ardia Passkeys.app") }

  static func setupState(_ reply: @escaping ([String: Any]) -> Void) {
    guard #available(macOS 26.0, *) else { return reply(["available": false, "reason": "macOS"]) }
    let executable = helperURL.appendingPathComponent("Contents/MacOS/ArdiaPasskeys")
    guard FileManager.default.isExecutableFile(atPath: executable.path) else { return reply(["available": false, "reason": "helper"]) }
    DispatchQueue.global(qos: .userInitiated).async {
      let process = Process()
      let output = Pipe()
      process.executableURL = executable
      process.arguments = ["--autofill-state"]
      process.standardOutput = output
      process.standardError = FileHandle.nullDevice
      var enabled: Bool?
      if (try? process.run()) != nil {
        let deadline = Date().addingTimeInterval(8)
        while process.isRunning && Date() < deadline { usleep(50_000) }
        if process.isRunning { process.terminate() }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        enabled = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["enabled"] as? Bool
      }
      DispatchQueue.main.async { reply(["available": true, "autofillEnabled": enabled.map { $0 as Any } ?? NSNull()]) }
    }
  }

  static func openHelper(_ argument: String) -> Bool {
    guard #available(macOS 26.0, *), FileManager.default.fileExists(atPath: helperURL.path) else { return false }
    if LaunchConfig.shared.background {
      NSLog("[passkeys] background: would open the helper with %@", argument)
      return true
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.arguments = [argument]
    configuration.createsNewApplicationInstance = true
    NSWorkspace.shared.openApplication(at: helperURL, configuration: configuration) { _, _ in }
    return true
  }

  static func openPasswordsApp() -> Bool {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Passwords") else { return false }
    if LaunchConfig.shared.background {
      NSLog("[passkeys] background: would open %@", url.path)
      return true
    }
    NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
    return true
  }

  static func importState() -> [String: Any] {
    guard !ArdiaHost.dataDirectory.isEmpty else { return [:] }
    let file = URL(fileURLWithPath: ArdiaHost.dataDirectory).appendingPathComponent("passkey-import-state.json")
    guard let data = try? Data(contentsOf: file), let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return state
  }

  static func clearImportState() {
    guard !ArdiaHost.dataDirectory.isEmpty else { return }
    try? FileManager.default.removeItem(at: URL(fileURLWithPath: ArdiaHost.dataDirectory).appendingPathComponent("passkey-import-state.json"))
  }
}
