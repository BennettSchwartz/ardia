import Foundation
import LocalAuthentication

struct PasskeyProviderEntry: Equatable {
  let profile: String
  let groupId: String
  let create: Bool
}

@objc(ArdiaPasskeyCoordinator)
public final class PasskeyCoordinator: NSObject {
  @objc(shared) public static let shared = PasskeyCoordinator()

  static let requestLifetime: TimeInterval = 120
  static let shortestLifetime: TimeInterval = 30
  static let longestLifetime: TimeInterval = 300
  static let promptSpacing: TimeInterval = 2

  private struct Pending {
    let id: String
    let op: String
    let nonce: String
    let pageId: Int
    let origin: String
    let document: Int
    let policy: PasskeyPolicy
    let get: PasskeyGetOptions?
    let create: PasskeyCreateOptions?
    let credentials: [PasskeyCredential]
    let rpId: String
    weak var page: ArdiaPasskeyPage?
    let started: Date
    let entry: PasskeyProviderEntry
    let generation: Int
    var resolving = false
  }

  var makeAuthenticator: () -> PasskeyAuthenticator? = {
    guard let suffixes = PasskeyPublicSuffixList.bundled else { return nil }
    return PasskeyAuthenticator(store: PasskeyCoordinator.defaultStore(), suffixes: suffixes)
  }
  var makeContext: () -> LAContext? = {
    let context = LAContext()
    context.touchIDAuthenticationAllowableReuseDuration = 0
    return context
  }
  var verifyOwner: (LAContext?, String, @escaping (Bool) -> Void) -> Void = { context, reason, done in
    guard let context else { return done(false) }
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in done(ok) }
  }
  var record: (String) -> Void = { _ in }
  var autoAnswer: String?
  var requiresVisiblePage = true

  private lazy var authenticator: PasskeyAuthenticator? = makeAuthenticator()
  private var providers: [String: PasskeyProviderEntry] = [:]
  private var generation = 0
  private var pending: [String: Pending] = [:]
  private var lastPrompt: [ObjectIdentifier: Date] = [:]
  private var contexts: [String: LAContext] = [:]

  static var testStore: PasskeyTestStore?

  static func defaultStore() -> PasskeyKeyStore {
    if let testStore { return testStore }
    let group = (Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String ?? "U5L5T3NGVV.") + "com.ardia.browser.passkeys"
    let lock = PasskeyCoordinator.lockPath ?? FileManager.default.temporaryDirectory.appendingPathComponent("ardia-passkeys.lock").path
    return PasskeyKeychainStore(accessGroup: group, lockPath: lock)
  }

  static var lockPath: String?

  func setProviders(_ entries: [PasskeyProviderEntry], generation next: Int) {
    guard next >= generation else { return }
    generation = next
    providers = Dictionary(entries.map { ($0.profile, $0) }, uniquingKeysWith: { first, _ in first })
    for (id, request) in pending where providers[request.policy.profile] != request.entry {
      finish(id, reply: ["fallThrough": true], reason: "withdrawn")
    }
  }

  @objc public func providesForProfile(_ profile: String) -> Bool { providers[profile] != nil }

  private func policy(for page: ArdiaPasskeyPage) -> PasskeyPolicy? {
    guard let entry = providers[page.passkeyProfile] else { return nil }
    return PasskeyPolicy(groupId: entry.groupId, create: entry.create, privateWindow: page.passkeyPrivate, profile: page.passkeyProfile)
  }

  private func reply(_ page: ArdiaPasskeyPage, _ nonce: String, _ pageId: Int, _ body: [String: Any]) {
    page.passkeyReply(nonce, pageId: pageId, reply: body)
  }

  @objc(request:options:nonce:pageId:origin:main:page:)
  public func request(_ op: String, options json: String, nonce: String, pageId: Int, origin: String?, main: Bool, page: ArdiaPasskeyPage) {
    let fallThrough: ([String: Any]) -> Void = { [weak page] body in if let page { self.reply(page, nonce, pageId, body) } }
    guard main, let origin, origin == page.passkeyTopOrigin, nonce.count <= 64, pageId > 0 else { return fallThrough(["fallThrough": true]) }
    guard let policy = policy(for: page), let entry = providers[page.passkeyProfile], let authenticator else { return fallThrough(["fallThrough": true]) }
    if op == "uvpaa" {
      let available = LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
      return fallThrough(available ? ["handled": true] : ["fallThrough": true])
    }
    guard page.passkeyVisible || !requiresVisiblePage else { return fallThrough(["fallThrough": true]) }
    guard let data = json.data(using: .utf8), data.count <= 64 * 1024, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return fallThrough(["fallThrough": true])
    }
    let pageKey = ObjectIdentifier(page)
    if pending.values.contains(where: { $0.page === page }) { return fallThrough(["error": "NotAllowedError", "message": "Another passkey request is open."]) }
    if let last = lastPrompt[pageKey], Date().timeIntervalSince(last) < Self.promptSpacing {
      return fallThrough(["error": "NotAllowedError", "message": "Too many passkey requests."])
    }
    var getOptions: PasskeyGetOptions?
    var createOptions: PasskeyCreateOptions?
    var credentials: [PasskeyCredential] = []
    var rpId = ""
    var promptKind = op
    switch op {
    case "get":
      guard let options = PasskeyGetOptions.parse(object), options.supported else { return fallThrough(["fallThrough": true]) }
      guard case .choose(let chosenRp, let offered) = authenticator.planGet(options, origin: origin, policy: policy) else {
        record("passkey_get_fell_through")
        return fallThrough(["fallThrough": true])
      }
      getOptions = options
      credentials = offered
      rpId = chosenRp
    case "create":
      guard let options = PasskeyCreateOptions.parse(object), options.supported else { return fallThrough(["fallThrough": true]) }
      switch authenticator.planCreate(options, origin: origin, policy: policy) {
      case .fallThrough: return fallThrough(["fallThrough": true])
      case .excluded(let chosenRp): rpId = chosenRp; promptKind = "excluded"
      case .offer(let chosenRp): rpId = chosenRp
      }
      createOptions = options
    default:
      return fallThrough(["fallThrough": true])
    }
    let document = page.passkeyDocument
    let id = UUID().uuidString
    pending[id] = Pending(
      id: id, op: op, nonce: nonce, pageId: pageId, origin: origin, document: document, policy: policy, get: getOptions, create: createOptions,
      credentials: credentials, rpId: rpId, page: page, started: Date(), entry: entry, generation: generation)
    page.passkeyConfirm(nonce, pageId: pageId) { [weak self, weak page] stillPending in
      guard let self, let page, let request = self.pending[id] else { return }
      guard stillPending, self.isCurrent(request, page) else { return self.finish(id, reply: ["fallThrough": true], reason: "stale") }
      self.lastPrompt[pageKey] = Date()
      page.passkeyEmit("passkeyRequest", payload: self.promptPayload(request, kind: promptKind))
      if let answer = self.autoAnswer {
        let accepted = ["get": "use", "create": "save", "excluded": "excludedOk"][promptKind] ?? "cancel"
        DispatchQueue.main.async { self.resolve(id, action: answer == "accept" ? accepted : answer, account: 0) }
      }
    }
    let requested = (getOptions?.timeoutMs ?? createOptions?.timeoutMs).map { $0 / 1000 } ?? Self.requestLifetime
    let lifetime = min(max(requested, Self.shortestLifetime), Self.longestLifetime)
    DispatchQueue.main.asyncAfter(deadline: .now() + lifetime) { [weak self] in
      self?.finish(id, reply: ["error": "NotAllowedError", "message": "The operation timed out."], reason: "expired")
    }
  }

  private func site(_ rpId: String) -> String { authenticator?.suffixes.registrableDomain(of: rpId) ?? rpId }

  private func promptPayload(_ request: Pending, kind: String) -> [String: Any] {
    let host = (try? PasskeyOrigin.parse(request.origin).host) ?? request.rpId
    return [
      "id": request.id,
      "kind": kind,
      "site": site(request.rpId),
      "host": host,
      "accounts": request.credentials.map { ["name": $0.userName, "displayName": $0.userDisplayName, "source": $0.source.rawValue] },
      "userName": request.create?.userName ?? "",
    ]
  }

  private func isCurrent(_ request: Pending, _ page: ArdiaPasskeyPage) -> Bool {
    page.passkeyDocument == request.document && page.passkeyTopOrigin == request.origin && page.passkeyProfile == request.policy.profile
      && providers[page.passkeyProfile] == request.entry && (page.passkeyVisible || !requiresVisiblePage)
  }

  private func finish(_ id: String, reply body: [String: Any], reason: String) {
    guard let request = pending.removeValue(forKey: id) else { return }
    contexts.removeValue(forKey: id)?.invalidate()
    if let page = request.page { page.passkeyReply(request.nonce, pageId: request.pageId, reply: body) }
    if reason != "answered", reason != "other" { request.page?.passkeyEmit("passkeyRequestEnded", payload: ["id": id, "reason": reason]) }
  }

  @objc(resolve:action:account:)
  public func resolve(_ id: String, action: String, account: Int) {
    guard let request = pending[id], !request.resolving, let page = request.page, let authenticator else { return }
    guard isCurrent(request, page) else { return finish(id, reply: ["fallThrough": true], reason: "stale") }
    pending[id]?.resolving = true
    let host = (try? PasskeyOrigin.parse(request.origin).host) ?? request.rpId
    switch action {
    case "other":
      record(request.op == "get" ? "passkey_get_fell_through" : "passkey_create_declined")
      finish(id, reply: ["fallThrough": true], reason: "other")
    case "use":
      guard let options = request.get, request.credentials.indices.contains(account) else { return finish(id, reply: ["error": "NotAllowedError"], reason: "cancelled") }
      let credential = request.credentials[account]
      let context = makeContext()
      context?.localizedReason = "sign in to \(host)"
      if let context { contexts[id] = context }
      DispatchQueue.global(qos: .userInitiated).async {
        let result = Result { try authenticator.assertion(credential, options: options, origin: request.origin, context: context) }
        DispatchQueue.main.async {
          guard let current = self.pending[id], let page = current.page, self.isCurrent(current, page) else { return self.finish(id, reply: ["fallThrough": true], reason: "stale") }
          switch result {
          case .success(let response):
            self.record("passkey_get_answered")
            self.finish(id, reply: ["handled": response], reason: "answered")
          case .failure(let error):
            self.record(error as? PasskeyStoreError == .cancelled ? "passkey_get_cancelled" : "passkey_get_failed")
            self.finish(id, reply: ["error": "NotAllowedError"], reason: "cancelled")
          }
        }
      }
    case "save", "excludedOk":
      guard let options = request.create else { return finish(id, reply: ["error": "NotAllowedError"], reason: "cancelled") }
      let context = makeContext()
      if let context { contexts[id] = context }
      verifyOwner(context, "save a passkey for \(host)") { verified in
        DispatchQueue.main.async {
          guard let current = self.pending[id], let page = current.page, self.isCurrent(current, page), verified else {
            self.record("passkey_create_declined")
            return self.finish(id, reply: ["error": "NotAllowedError"], reason: "cancelled")
          }
          if action == "excludedOk" { return self.finish(id, reply: ["error": "InvalidStateError", "message": "A passkey for this account is already saved."], reason: "answered") }
          do {
            let response = try authenticator.registration(options, origin: current.origin, policy: current.policy, verifiedOwner: true)
            self.record("passkey_create_saved")
            self.finish(id, reply: ["handled": response], reason: "answered")
          } catch {
            self.record("passkey_create_failed")
            self.finish(id, reply: ["error": "NotAllowedError"], reason: "cancelled")
          }
        }
      }
    default:
      record(request.op == "get" ? "passkey_get_cancelled" : "passkey_create_declined")
      finish(id, reply: ["error": "NotAllowedError", "message": "The operation either timed out or was not allowed."], reason: "cancelled")
    }
  }

  @objc(cancel:pageId:page:)
  public func cancel(_ nonce: String, pageId: Int, page: ArdiaPasskeyPage) {
    for (id, request) in pending where request.page === page && request.nonce == nonce && request.pageId == pageId {
      pending.removeValue(forKey: id)
      contexts.removeValue(forKey: id)?.invalidate()
      page.passkeyEmit("passkeyRequestEnded", payload: ["id": id, "reason": "aborted"])
    }
  }

  @objc(pageChanged:)
  public func pageChanged(_ page: ArdiaPasskeyPage) {
    for (id, request) in pending where request.page === page && !isCurrent(request, page) {
      finish(id, reply: ["fallThrough": true], reason: "stale")
    }
  }

  func pendingCount() -> Int { pending.count }

  func list(group: String) -> [[String: Any]] {
    let stored = (try? authenticator?.store.credentials(groupId: group, rpId: nil)) ?? []
    return stored.map {
      ["rpId": $0.rpId, "credentialId": PasskeyBase64URL.encode($0.credentialId), "userName": $0.userName, "userDisplayName": $0.userDisplayName,
       "created": $0.created.timeIntervalSince1970 * 1000, "source": $0.source.rawValue]
    }
  }

  func delete(group: String, rpId: String, credentialId: String) -> Bool {
    guard let id = PasskeyBase64URL.decode(credentialId), let store = authenticator?.store,
      let credential = (try? store.credentials(groupId: group, rpId: rpId))?.first(where: { $0.credentialId == id })
    else { return false }
    guard (try? store.delete(credential)) != nil else { return false }
    record("passkey_deleted_manage")
    return true
  }

  func deleteAll(group: String) -> Int {
    let deleted = (try? authenticator?.store.deleteAll(groupId: group)) ?? 0
    if deleted > 0 { record("passkey_deleted_all") }
    return deleted ?? 0
  }
}
