import ExpoModulesCore

public class PasswordsModule: Module {
  public func definition() -> ModuleDefinition {
    Name(Self.calls.moduleName)

    Self.calls.function

    AsyncFunction("save") { (profile: String, origin: String, username: String, password: String, promise: Promise) in
      ArdiaServices.savePassword(profile: profile, origin: origin, username: username, password: password) {
        CallReply(promise: promise).service($0, $1)
      }
    }.runOnQueue(.main)

    AsyncFunction("update") {
      (profile: String, origin: String, username: String, newUsername: String?, newPassword: String?, promise: Promise) in
      ArdiaServices.updatePassword(profile: profile, origin: origin, username: username, newUsername: newUsername,
                                   newPassword: newPassword) { CallReply(promise: promise).service($0, $1) }
    }.runOnQueue(.main)
  }

  static let calls = CallTable(domain: "passwords", handlers: [
    "list": { args, reply in ArdiaServices.listPasswords(profile: args.profile) { reply.service($0, $1) } },
    "unlock": { args, reply in ArdiaServices.unlockPasswords(profile: args.profile) { reply.service($0, $1) } },
    "reveal": { args, reply in
      ArdiaServices.password(profile: args.profile, origin: try args.text("origin"), username: try args.text("username")) { reply.service($0, $1) }
    },
    "remove": { args, reply in
      ArdiaServices.deletePassword(profile: args.profile, origin: try args.text("origin"), username: try args.text("username")) { reply.service($0, $1) }
    },
    "neverSaveOrigins": { args, reply in ArdiaServices.neverSaveOrigins(profile: args.profile) { reply.service($0, $1) } },
    "allowSaving": { args, reply in ArdiaServices.allowSaving(profile: args.profile, origin: try args.text("origin")) { reply.service($0, $1) } },
    "export": { args, reply in ArdiaServices.exportPasswords(profile: args.profile, path: nil) { reply.service($0, $1) } },
    "autofillEnabled": { args, reply in
      ArdiaServices.profileToggles(profile: args.profile, set: nil) { toggles, error in
        guard let toggles = toggles as? [String: Bool], let enabled = toggles["passwords"] else { return reply.service(nil, error ?? "no password setting") }
        reply.ok(enabled)
      }
    },
    "setAutofillEnabled": { args, reply in
      let enabled = try args.bool("enabled")
      ArdiaServices.profileToggles(profile: args.profile, set: ["passwords": NSNumber(value: enabled)]) { _, error in reply.service(nil, error) }
    },
    "setFieldProviders": { args, reply in
      let generation = try args.double("generation")
      let session = try args.text("session")
      let profiles = try args.dicts("profiles")
      let applied = ArdiaWebView.setFieldProviders(profiles, generation: generation, session: session)
      if applied { WebKitHub.shared.transfers.liveTabs.forEach { $0.pushFieldProvider() } }
      reply.ok(["applied": applied])
    },
    "showSystemPanel": { args, reply in
      let tab = try args.text("tab")
      let generation = try args.optionalDouble("generation") ?? -1
      if let live = WebKitHub.shared.transfers.liveTab(tab) { return live.showSystemPanel(generation: generation) { reply.ok($0) } }
      if !ArdiaWebView.showSystemPanel(tab: tab, generation: generation, completion: { reply.ok($0) }) {
        reply.ok(["shown": false, "reason": "noTab"])
      }
    },
    "showPanelHint": { args, reply in
      let tab = try args.text("tab")
      let label = try args.text("label")
      let side = try args.text("side")
      if let live = WebKitHub.shared.transfers.liveTab(tab) { return reply.ok(["shown": live.showFieldProviderHint(label: label, side: side)]) }
      reply.ok(["shown": ArdiaWebView.showFieldProviderHint(label, side: side, tab: tab)])
    },
    "systemPanelAvailable": { _, reply in reply.ok(ArdiaWebView.systemPanelAvailability) },
    "setPasskeyProviders": { args, reply in
      let generation = try args.int("generation")
      let providers = try args.dicts("providers").compactMap { entry -> PasskeyProviderEntry? in
        guard let profile = entry["profile"] as? String, let group = entry["group"] as? String else { return nil }
        return PasskeyProviderEntry(profile: profile, groupId: group, create: entry["create"] as? Bool ?? true)
      }
      PasskeyCoordinator.shared.setProviders(providers, generation: generation)
      ArdiaWebView.pushPasskeyConfigEverywhere()
      reply.ok(["applied": true])
    },
    "resolvePasskey": { args, reply in
      PasskeyCoordinator.shared.resolve(try args.text("id"), action: try args.text("action"), account: try args.optionalDouble("account").map { Int($0) } ?? -1)
      reply.ok(nil)
    },
    "passkeys": { args, reply in reply.ok(["passkeys": PasskeyCoordinator.shared.list(group: try args.text("group"))]) },
    "deletePasskey": { args, reply in
      reply.ok(["deleted": PasskeyCoordinator.shared.delete(group: try args.text("group"), rpId: try args.text("rpId"), credentialId: try args.text("credentialId"))])
    },
    "deleteAllPasskeys": { args, reply in reply.ok(["deleted": PasskeyCoordinator.shared.deleteAll(group: try args.text("group"))]) },
    "otpauthHandler": { _, reply in reply.ok(["app": ArdiaWebView.otpauthHandlerName as Any? ?? NSNull()]) },
    "setUpVerificationCode": { args, reply in
      let tab = try args.text("tab")
      let token = try args.text("token")
      let generation = try args.optionalDouble("generation") ?? -1
      if let live = WebKitHub.shared.transfers.liveTab(tab) { return live.setUpVerificationCode(token, generation: generation) { reply.ok($0) } }
      if !ArdiaWebView.setUpVerificationCode(token, tab: tab, generation: generation, completion: { reply.ok($0) }) {
        reply.ok(["opened": false, "reason": "noTab"])
      }
    },
  ])
}
