import Foundation

final class PluginCertificateCache {
  private let queue = DispatchQueue(label: "ardia.plugins.certificates", qos: .utility)
  private let lock = NSLock()
  private var computed: (key: [String: String], value: PluginSandbox.Certificates)?
  private var computing: [String: String]?
  private let system: String

  init(system: String = PluginSandbox.systemCertificates) {
    self.system = system
  }

  static func key(of given: [String: String]) -> [String: String] {
    given.filter { PluginSandbox.certificateEnvironment.contains($0.key) }
  }

  func current(for given: [String: String]) -> PluginSandbox.Certificates? {
    let key = Self.key(of: given)
    lock.lock()
    defer { lock.unlock() }
    if let computed, computed.key == key { return computed.value }
    if computing != key {
      computing = key
      queue.async { [self] in
        let value = PluginSandbox.certificates(from: key, system: system)
        lock.lock()
        computed = (key, value)
        if computing == key { computing = nil }
        lock.unlock()
      }
    }
    return nil
  }
}
