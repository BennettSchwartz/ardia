import CryptoKit
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
    guard let storeId = PasskeyStoreIdentity.load(directory: directory.path) else { return nil }
    let store = PasskeyKeychainStore(accessGroup: "U5L5T3NGVV.com.ardia.browser.passkeys", storeId: storeId, lockPath: directory.appendingPathComponent("passkeys.lock").path)
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
                                 "skippedRelyingParty": counts.skippedRelyingParty, "skippedAlgorithm": counts.skippedAlgorithm, "failed": counts.failed,
                                 "failures": counts.failures]
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

enum StoreSelfTest {
  static func throwawayId(_ name: String) -> String { "\(name)-\(UUID().uuidString.lowercased())" }

  static func scope() -> String {
    let lock = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-passkeys-scope-test.lock").path
    let group = "U5L5T3NGVV.com.ardia.browser.passkeys"
    let idA = throwawayId("selftest-a")
    let idB = throwawayId("selftest-b")
    let a = PasskeyKeychainStore(accessGroup: group, storeId: idA, lockPath: lock)
    let b = PasskeyKeychainStore(accessGroup: group, storeId: idB, lockPath: lock)
    var credentialId = Data(count: 16)
    _ = credentialId.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
    let record = PasskeyCredential(
      groupId: "scope-test", rpId: "scope-test.invalid", credentialId: credentialId, userHandle: Data("t".utf8), userName: "t",
      userDisplayName: "t", created: Date(), source: .ardia, backupEligible: false, ready: false)
    let keyA = P256.Signing.PrivateKey()
    let keyB = P256.Signing.PrivateKey()
    var steps: [String: String] = ["serviceA": PasskeyKeychainStore.servicePrefix + idA, "serviceB": PasskeyKeychainStore.servicePrefix + idB]
    let run = { (name: String, body: () throws -> String) in
      do { steps[name] = try body() } catch { steps[name] = PasskeyStoreError.code(error) }
    }
    run("aAdd") { "\(try a.add(record, privateX963: keyA.x963Representation))" }
    run("bListBeforeOwnAdd") { "\(try b.credentials(groupId: "scope-test", rpId: nil).count)" }
    run("bDeleteAll") { "\(try b.deleteAll(groupId: "scope-test"))" }
    run("bDeleteOne") { try b.delete(record); return "done" }
    run("bRecover") { try b.recover(); return "done" }
    run("aListAfterB") { "\(try a.credentials(groupId: "scope-test", rpId: nil).count)" }
    run("bAddSameCredential") { "\(try b.add(record, privateX963: keyB.x963Representation))" }
    run("aAddAgainSameKey") { "\(try a.add(record, privateX963: keyA.x963Representation))" }
    run("aRecover") { try a.recover(); return "done" }
    run("bListAfterARecover") { "\(try b.credentials(groupId: "scope-test", rpId: nil).count)" }
    run("aDeleteAll") { "\(try a.deleteAll(groupId: "scope-test"))" }
    run("bListAfterADelete") { "\(try b.credentials(groupId: "scope-test", rpId: nil).count)" }
    run("bDeleteAllOwn") { "\(try b.deleteAll(groupId: "scope-test"))" }
    let data = (try? JSONSerialization.data(withJSONObject: steps, options: [.sortedKeys, .prettyPrinted])) ?? Data()
    return String(data: data, encoding: .utf8) ?? "{}"
  }

  static func run() -> String {
    let lock = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-passkeys-self-test.lock").path
    let store = PasskeyKeychainStore(accessGroup: "U5L5T3NGVV.com.ardia.browser.passkeys", storeId: StoreSelfTest.throwawayId("selftest"), lockPath: lock)
    let key = P256.Signing.PrivateKey()
    var id = Data(count: 16)
    _ = id.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
    let record = PasskeyCredential(
      groupId: "ardia-store-self-test", rpId: "self-test.invalid", credentialId: id, userHandle: Data("t".utf8), userName: "t",
      userDisplayName: "t", created: Date(), source: .ardia, backupEligible: false, ready: false)
    var steps: [String: String] = [:]
    do { steps["add"] = "\(try store.add(record, privateX963: key.x963Representation))" } catch { steps["add"] = PasskeyStoreError.code(error) }
    do { steps["addAgain"] = "\(try store.add(record, privateX963: key.x963Representation))" } catch { steps["addAgain"] = PasskeyStoreError.code(error) }
    do { steps["list"] = "\(try store.credentials(groupId: "ardia-store-self-test", rpId: nil).count)" } catch { steps["list"] = PasskeyStoreError.code(error) }
    do { steps["deleteAll"] = "\(try store.deleteAll(groupId: "ardia-store-self-test"))" } catch { steps["deleteAll"] = PasskeyStoreError.code(error) }
    let data = (try? JSONSerialization.data(withJSONObject: steps, options: .sortedKeys)) ?? Data()
    return String(data: data, encoding: .utf8) ?? "{}"
  }
}

extension StoreSelfTest {
  static func importWalk() -> String {
    guard #available(macOS 26.1, *), let suffixes = PasskeyPublicSuffixList.bundled else { return "{\"error\":\"setup\"}" }
    let arguments = CommandLine.arguments
    let lockDirectory = arguments.firstIndex(of: "--lock-dir").flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }
    let lock = lockDirectory.map { ($0 as NSString).appendingPathComponent("passkeys.lock") }
      ?? FileManager.default.temporaryDirectory.appendingPathComponent("ardia-passkeys-self-test.lock").path
    let store = PasskeyKeychainStore(accessGroup: "U5L5T3NGVV.com.ardia.browser.passkeys", storeId: StoreSelfTest.throwawayId("selftest"), lockPath: lock)
    let items = (1...5).map { n -> ASImportableItem in
      let passkey = ASImportableCredential.Passkey(
        credentialID: Data((0..<16).map { _ in UInt8.random(in: 0...255) }), relyingPartyIdentifier: "site\(n).self-test.example",
        userName: "t\(n)", userDisplayName: "T", userHandle: Data("h\(n)".utf8), key: P256.Signing.PrivateKey().derRepresentation)
      return ASImportableItem(id: Data("i\(n)".utf8), title: "t", credentials: [.passkey(passkey)])
    }
    let export = ASExportedCredentialData(
      accounts: [ASImportableAccount(id: Data("a".utf8), userName: "u", email: "e@example.com", collections: [], items: items)],
      formatVersion: .v1, exporterRelyingPartyIdentifier: "self-test", exporterDisplayName: "self-test", timestamp: Date())
    let counts = PasskeyImport.keep(export, groupId: "ardia-import-self-test", store: store, suffixes: suffixes)
    let removed = (try? store.deleteAll(groupId: "ardia-import-self-test")) ?? -1
    let data = (try? JSONSerialization.data(withJSONObject: ["added": counts.added, "failed": counts.failed, "failures": counts.failures, "skippedRelyingParty": counts.skippedRelyingParty, "removed": removed], options: .sortedKeys)) ?? Data()
    return String(data: data, encoding: .utf8) ?? "{}"
  }
}

enum HelperCommand {
  static func run(_ arguments: [String]) -> Bool {
    if arguments.contains("--scope-self-test") {
      print(StoreSelfTest.scope())
      return true
    }
    if arguments.contains("--import-self-test") {
      let result = StoreSelfTest.importWalk()
      print(result)
      if let i = arguments.firstIndex(of: "--out"), i + 1 < arguments.count { try? result.write(toFile: arguments[i + 1], atomically: true, encoding: .utf8) }
      return true
    }
    if arguments.contains("--store-self-test") {
      print(StoreSelfTest.run())
      return true
    }
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
