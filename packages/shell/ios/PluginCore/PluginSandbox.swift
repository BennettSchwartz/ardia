import Foundation

struct PluginSandbox {
  let home: String
  let appData: String
  let configFolder: String
  let pluginFolder: String
  let pluginData: String
  let program: String
  let network: Bool

  static let searchPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"]

  static let machAllowed = [
    "com.apple.system.opendirectoryd.libinfo", "com.apple.system.opendirectoryd.membership", "com.apple.logd", "com.apple.bsd.dirhelper",
    "com.apple.cfprefsd.agent", "com.apple.cfprefsd.daemon",
  ]

  static let machAllowedOnline = [
    "com.apple.SystemConfiguration.DNSConfiguration", "com.apple.SystemConfiguration.configd", "com.apple.trustd", "com.apple.trustd.agent",
    "com.apple.TrustEvaluationAgent",
  ]

  static let unixSocketsAllowedOnline = ["/private/var/run/mDNSResponder"]

  static let preferenceDomainsAllowed = ["kCFPreferencesAnyApplication"]

  static let devicesWritable = ["/dev/null", "/dev/zero"]

  static let unreadableTrees = ["/Users", "/Volumes"]

  static let proxyEnvironment = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"]

  static let certificateEnvironment = ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]

  static let systemCertificates = "/etc/ssl/cert.pem"

  static let certificateBundleName = "certificates.pem"

  struct NetworkEnvironment: Equatable {
    var variables: [String] = []
    var droppedProxies: [String] = []
  }

  static func carriesCredentials(_ value: String) -> Bool {
    guard let url = URL(string: value.contains("://") ? value : "http://\(value)") else { return value.contains("@") }
    return url.user != nil || url.password != nil || (url.host == nil && value.contains("@"))
  }

  static func certificateBundle(from given: [String: String], system: String = systemCertificates) -> String {
    var sources = [system]
    for name in certificateEnvironment {
      if let path = given[name], !path.isEmpty, !sources.contains(path) { sources.append(path) }
    }
    return sources.compactMap { try? String(contentsOfFile: $0, encoding: .utf8) }.map { $0.hasSuffix("\n") ? $0 : $0 + "\n" }.joined()
  }

  static func networkEnvironment(from given: [String: String], network: Bool, dataFolder: String, system: String = systemCertificates) -> NetworkEnvironment {
    guard network else { return NetworkEnvironment() }
    var result = NetworkEnvironment()
    for name in proxyEnvironment {
      guard let value = given[name], !value.isEmpty, !value.contains("\0") else { continue }
      if carriesCredentials(value) {
        result.droppedProxies.append(name)
        continue
      }
      result.variables.append("\(name)=\(value)")
    }
    let bundle = (dataFolder as NSString).appendingPathComponent(certificateBundleName)
    let staged = certificateBundle(from: given, system: system)
    if !staged.isEmpty, (try? staged.write(toFile: bundle, atomically: true, encoding: .utf8)) != nil {
      result.variables += ["SSL_CERT_FILE=\(bundle)", "NODE_EXTRA_CA_CERTS=\(bundle)", "GIT_SSL_CAINFO=\(bundle)"]
    }
    return result
  }

  static func profile(network: Bool) -> String {
    let mach = machAllowed + (network ? machAllowedOnline : [])
    let preferences = preferenceDomainsAllowed.isEmpty
      ? "" : "\n(allow user-preference-read \(preferenceDomainsAllowed.map { "(preference-domain \"\($0)\")" }.joined(separator: " ")))"
    let sockets = network
      ? "\n(allow network-outbound \(unixSocketsAllowedOnline.map { "(remote unix-socket (literal \"\($0)\"))" }.joined(separator: " ")))" : ""
    let addresses = network
      ? ""
      : """

        (deny network-outbound (remote ip))
        (deny network-bind (local ip))
        (deny network-inbound (local ip))
        """
    return """
      (version 1)
      (allow default)
      (deny appleevent-send)
      (deny lsopen)
      (deny job-creation)
      (deny distributed-notification-post)
      (deny darwin-notification-post)
      (deny user-preference-write)
      (deny user-preference-read)\(preferences)
      (deny iokit-open)
      (deny sysctl-write)
      (allow sysctl-read)
      (deny process-info* signal)
      (allow process-info* signal (target same-sandbox))
      (allow process-info-listpids)
      (deny ipc-posix-shm*)
      (allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center") (ipc-posix-name-prefix "apple.cfprefs."))
      (deny mach-lookup)
      (allow mach-lookup \(mach.map { "(global-name \"\($0)\")" }.joined(separator: " ")))
      (deny file-read* file-write* (subpath (param "HOME")) (subpath (param "APP_DATA")) (subpath (param "CONFIG")))
      (deny file-read* file-write* \(unreadableTrees.map { "(subpath \"\($0)\")" }.joined(separator: " ")))
      (allow file-read-metadata \(unreadableTrees.map { "(literal \"\($0)\")" }.joined(separator: " ")))
      (deny file-write* (subpath "/"))
      (allow file-write* \(devicesWritable.map { "(literal \"\($0)\")" }.joined(separator: " ")) (subpath "/dev/fd"))
      (deny network-outbound (remote unix-socket))\(sockets)\(addresses)
      (allow file-read* (subpath (param "PLUGIN")) (literal (param "PROGRAM")) (subpath (param "INSTALL")))
      (allow file-read* file-write* (subpath (param "DATA")))
      (allow file-read-metadata (literal (param "HOME")))
      """
  }

  enum Refusal: Error {
    case unsafe(String)
  }

  static func resolved(_ path: String) -> String? {
    guard let real = realpath(path, nil) else { return nil }
    defer { free(real) }
    return String(cString: real)
  }

  static func isInside(_ path: String, _ folder: String) -> Bool {
    path == folder || path.hasPrefix(folder.hasSuffix("/") ? folder : folder + "/")
  }

  static func overlaps(_ a: String, _ b: String) -> Bool { isInside(a, b) || isInside(b, a) }

  static func program(_ first: String, pluginFolder: String) -> String? {
    if first.hasPrefix("/") { return resolved(first) }
    if first.contains("/") {
      guard let real = resolved((pluginFolder as NSString).appendingPathComponent(first)), isInside(real, pluginFolder) else { return nil }
      return real
    }
    for dir in searchPath {
      let candidate = (dir as NSString).appendingPathComponent(first)
      if FileManager.default.isExecutableFile(atPath: candidate) { return resolved(candidate) }
    }
    return nil
  }

  private var protected: [String] { [home, appData, configFolder] }

  func installFolder() -> String {
    let parent = (program as NSString).deletingLastPathComponent
    let folder = (parent as NSString).lastPathComponent == "bin" ? (parent as NSString).deletingLastPathComponent : parent
    if folder == "/" || folder.split(separator: "/").count < 2 || protected.contains(where: { Self.overlaps($0, folder) }) { return program }
    return folder
  }

  func checked() throws {
    for path in [pluginFolder, pluginData, program] where path.isEmpty || path.contains("\0") {
      throw Refusal.unsafe("a path the sandbox can't name")
    }
    let pluginsRoot = (configFolder as NSString).appendingPathComponent("plugins")
    let inPluginsRoot = Self.isInside(pluginFolder, pluginsRoot) && pluginFolder != pluginsRoot
    if pluginFolder == "/" || [home, configFolder, appData].contains(where: { Self.isInside($0, pluginFolder) }) {
      throw Refusal.unsafe("its folder takes in Ardia's data, its settings or your home folder")
    }
    if (Self.isInside(pluginFolder, configFolder) || Self.isInside(pluginFolder, appData)) && !inPluginsRoot {
      throw Refusal.unsafe("its folder is in Ardia's data or config folder")
    }
    if !Self.isInside(program, pluginFolder) && (Self.isInside(program, appData) || Self.isInside(program, configFolder)) {
      throw Refusal.unsafe("its program is in Ardia's data or config folder")
    }
    guard Self.isInside(pluginData, appData), !Self.isInside(appData, pluginData) else { throw Refusal.unsafe("its data folder is in the wrong place") }
  }

  func arguments() throws -> [String] {
    try checked()
    let parameters = [
      "HOME": home, "APP_DATA": appData, "CONFIG": configFolder, "PLUGIN": pluginFolder, "DATA": pluginData, "PROGRAM": program,
      "INSTALL": installFolder(),
    ]
    return ["-p", Self.profile(network: network)] + parameters.sorted { $0.key < $1.key }.flatMap { ["-D", "\($0.key)=\($0.value)"] }
  }
}
