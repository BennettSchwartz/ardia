import AppKit
import AuthenticationServices
import Darwin

struct PasskeyGroupsFile: Decodable {
  struct Group: Decodable {
    let id: String
    let name: String
  }
  let generation: Int
  let groups: [Group]
}

struct ActiveArdia: Decodable {
  let dataDirectory: String
}

enum HelperPaths {
  static let pointer = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/com.ardia.browser.passkey-import/active.json")

  static func dataDirectory() -> URL? {
    guard let data = try? Data(contentsOf: pointer), let active = try? JSONDecoder().decode(ActiveArdia.self, from: data) else { return nil }
    return URL(fileURLWithPath: active.dataDirectory, isDirectory: true)
  }

  static func groups(in directory: URL) -> PasskeyGroupsFile? {
    guard let data = try? Data(contentsOf: directory.appendingPathComponent("passkey-groups.json")) else { return nil }
    return try? JSONDecoder().decode(PasskeyGroupsFile.self, from: data)
  }
}

final class HelperDelegate: NSObject, NSApplicationDelegate {
  private var busy = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    var none = rlimit(rlim_cur: 0, rlim_max: 0)
    setrlimit(RLIMIT_CORE, &none)
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
      if self?.busy == false { NSApp.terminate(nil) }
    }
  }

  func application(_ application: NSApplication, willContinueUserActivityWithType userActivityType: String) -> Bool {
    userActivityType == ASCredentialExchangeActivity
  }

  func application(_ application: NSApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([any NSUserActivityRestoring]) -> Void) -> Bool {
    guard userActivity.activityType == ASCredentialExchangeActivity, !busy else { return false }
    busy = true
    guard let token = userActivity.userInfo?[ASCredentialImportToken] as? UUID else {
      finish("Couldn't copy passkeys.", "Passwords didn't send an export. Start it again in Passwords.")
      return true
    }
    guard let directory = HelperPaths.dataDirectory(), let groups = HelperPaths.groups(in: directory), !groups.groups.isEmpty else {
      finish("Turn on Apple Passwords in Ardia first.", "Open Ardia › Settings › Plugins › Apple Passwords, turn it on, then export again from Passwords. Nothing was copied.")
      return true
    }
    Self.writeState("received", directory: directory)
    ask(groups: groups, directory: directory, token: token)
    return true
  }

  private func ask(groups: PasskeyGroupsFile, directory: URL, token: UUID) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "Copy passkeys from Apple Passwords?"
    alert.informativeText = "Passwords sends Ardia the whole export, including passwords, notes and cards. Ardia goes through it to copy the passkeys and saves only those, in this Mac's keychain. Nothing else is kept. This is a one-time copy, not a sync."
    let picker = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 260, height: 26), pullsDown: false)
    for group in groups.groups { picker.addItem(withTitle: group.name) }
    if groups.groups.count > 1 { alert.accessoryView = picker }
    alert.addButton(withTitle: "Copy Passkeys")
    alert.addButton(withTitle: "Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else {
      Self.writeState("cancelled", directory: directory)
      return finish(nil, nil)
    }
    let group = groups.groups[max(0, picker.indexOfSelectedItem)]
    Self.writeState("copying", directory: directory, group: group.name)
    Task { @MainActor in
      let counts = await Self.copy(token: token, groupId: group.id, generation: groups.generation, directory: directory)
      guard let counts else {
        Self.writeState("failed", directory: directory)
        return self.finish("Couldn't copy passkeys.", "Passwords cancelled the export, it expired, or Ardia's settings changed. Start it again in Passwords.")
      }
      Self.writeResult(counts, directory: directory)
      Self.writeState("done", directory: directory, group: group.name, counts: counts)
      let already = counts.existing > 0 ? " \(counts.existing) were already in Ardia." : ""
      self.finish("Copied \(counts.kept) passkeys to \(group.name).", "\(already) Nothing else from the export was kept.".trimmingCharacters(in: .whitespaces))
    }
  }

  private static func copy(token: UUID, groupId: String, generation: Int, directory: URL) async -> PasskeyImportCounts? {
    guard let suffixes = PasskeyPublicSuffixList.bundled else { return nil }
    let store = PasskeyKeychainStore(accessGroup: "U5L5T3NGVV.com.ardia.browser.passkeys", lockPath: directory.appendingPathComponent("passkeys.lock").path)
    do {
      let export = try await ASCredentialImportManager().importCredentials(token: token)
      guard let current = HelperPaths.groups(in: directory), current.generation == generation, current.groups.contains(where: { $0.id == groupId }) else { return nil }
      return PasskeyImport.keep(export, groupId: groupId, store: store, suffixes: suffixes)
    } catch {
      return nil
    }
  }

  static func writeState(_ phase: String, directory: URL, group: String? = nil, counts: PasskeyImportCounts? = nil) {
    var state: [String: Any] = ["phase": phase, "at": Date().timeIntervalSince1970 * 1000]
    if let group { state["group"] = group }
    if let counts { state["kept"] = counts.kept; state["existing"] = counts.existing; state["skipped"] = counts.skippedRelyingParty + counts.skippedAlgorithm + counts.failed }
    if let data = try? JSONSerialization.data(withJSONObject: state) {
      try? data.write(to: directory.appendingPathComponent("passkey-import-state.json"), options: .atomic)
    }
  }

  private static func writeResult(_ counts: PasskeyImportCounts, directory: URL) {
    let result: [String: Any] = ["at": Date().timeIntervalSince1970 * 1000, "kept": counts.kept, "existing": counts.existing,
                                 "skippedRelyingParty": counts.skippedRelyingParty, "skippedAlgorithm": counts.skippedAlgorithm, "failed": counts.failed]
    if let data = try? JSONSerialization.data(withJSONObject: result) {
      try? data.write(to: directory.appendingPathComponent("passkey-import-result.json"), options: .atomic)
    }
  }

  private func finish(_ title: String?, _ detail: String?) {
    if let title {
      NSApp.setActivationPolicy(.regular)
      NSApp.activate(ignoringOtherApps: true)
      let alert = NSAlert()
      alert.messageText = title
      alert.informativeText = detail ?? ""
      alert.addButton(withTitle: "Done")
      alert.runModal()
    }
    NSApp.terminate(nil)
  }
}

enum HelperCommand {
  static func run(_ arguments: [String]) -> Bool {
    if arguments.contains("--autofill-state") {
      let done = DispatchSemaphore(value: 0)
      var enabled = false
      ASCredentialIdentityStore.shared.getState { state in
        enabled = state.isEnabled
        done.signal()
      }
      _ = done.wait(timeout: .now() + 5)
      print("{\"enabled\":\(enabled)}")
      return true
    }
    return false
  }
}

if HelperCommand.run(CommandLine.arguments) { exit(0) }

final class SettingsDelegate: NSObject, NSApplicationDelegate {
  let openSettings: Bool
  init(openSettings: Bool) { self.openSettings = openSettings }
  func applicationDidFinishLaunching(_ notification: Notification) {
    if openSettings {
      ASSettingsHelper.openCredentialProviderAppSettings { _ in DispatchQueue.main.async { NSApp.terminate(nil) } }
    } else {
      ASSettingsHelper.requestToTurnOnCredentialProviderExtension { _ in DispatchQueue.main.async { NSApp.terminate(nil) } }
    }
  }
}

if CommandLine.arguments.contains("--turn-on") || CommandLine.arguments.contains("--open-settings") {
  let settingsApp = NSApplication.shared
  let settingsDelegate = SettingsDelegate(openSettings: CommandLine.arguments.contains("--open-settings"))
  settingsApp.delegate = settingsDelegate
  settingsApp.setActivationPolicy(.accessory)
  settingsApp.run()
  exit(0)
}

let app = NSApplication.shared
let delegate = HelperDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
