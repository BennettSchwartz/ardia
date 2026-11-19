import Foundation

final class PluginCertificateCache {
  static let preparationLimit: TimeInterval = 3

  private let queue = DispatchQueue(label: "ardia.plugins.certificates", qos: .userInitiated)
  private let lock = NSLock()
  private var cached: (key: [String: String], identities: [String: PluginSandbox.SourceIdentity], value: PluginSandbox.Certificates)?
  private let system: String

  init(system: String = PluginSandbox.systemCertificates) {
    self.system = system
  }

  static func key(of given: [String: String]) -> [String: String] {
    given.filter { PluginSandbox.certificateEnvironment.contains($0.key) }
  }

  func load(_ key: [String: String]) -> PluginSandbox.Certificates {
    lock.lock()
    let previous = cached
    lock.unlock()
    if let previous, previous.key == key, previous.identities.allSatisfy({ PluginSandbox.identity(of: $0.key) == $0.value }) {
      return previous.value
    }
    let loaded = PluginSandbox.loadCertificates(from: key, system: system)
    lock.lock()
    cached = loaded.complete ? (key, loaded.identities, loaded.certificates) : nil
    lock.unlock()
    return loaded.certificates
  }

  func prepare(
    for given: [String: String], within limit: TimeInterval = preparationLimit, deliverOn target: DispatchQueue,
    then: @escaping (PluginSandbox.PreparedCertificates) -> Void
  ) {
    let key = Self.key(of: given)
    guard !PluginSandbox.extraCertificateSources(from: key, system: system).isEmpty else {
      target.async { then(.notConfigured) }
      return
    }
    let answer = PluginAnswerOnce()
    target.asyncAfter(deadline: .now() + limit) {
      if answer.claim() { then(.timedOut) }
    }
    queue.async { [self] in
      let value = load(key)
      target.async {
        if answer.claim() { then(.ready(value)) }
      }
    }
  }
}

final class PluginAnswerOnce {
  private let lock = NSLock()
  private var answered = false

  func claim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if answered { return false }
    answered = true
    return true
  }
}
