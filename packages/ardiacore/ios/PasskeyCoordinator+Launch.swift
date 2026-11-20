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
