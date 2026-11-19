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
    "com.apple.system.opendirectoryd.libinfo", "com.apple.system.opendirectoryd.membership",
    "com.apple.logd", "com.apple.bsd.dirhelper", "com.apple.SystemConfiguration.configd",
    "com.apple.trustd", "com.apple.trustd.agent", "com.apple.TrustEvaluationAgent", "com.apple.cfprefsd.agent", "com.apple.cfprefsd.daemon",
  ]

  static let machAllowedOnline = ["com.apple.SystemConfiguration.DNSConfiguration"]

  static let unixSocketsAllowedOnline = ["/private/var/run/mDNSResponder"]

  static let preferenceDomainsAllowed = ["kCFPreferencesAnyApplication"]

  static let devicesWritable = ["/dev/null", "/dev/zero"]

  static let carriedEnvironment = [
    "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  ]

  static let systemCertificates = "/etc/ssl/cert.pem"

  static func networkEnvironment(from given: [String: String]) -> [String] {
    var carried = carriedEnvironment.compactMap { name in given[name].flatMap { $0.isEmpty || $0.contains("\0") ? nil : "\(name)=\($0)" } }
    if given["SSL_CERT_FILE"]?.isEmpty ?? true { carried.append("SSL_CERT_FILE=\(systemCertificates)") }
    return carried
  }

  static func profile(network: Bool) -> String {
    let mach = machAllowed + (network ? machAllowedOnline : [])
    let preferences = preferenceDomainsAllowed.isEmpty
      ? "" : "\n(allow user-preference-read \(preferenceDomainsAllowed.map { "(preference-domain \"\($0)\")" }.joined(separator: " ")))"
    let sockets = network
      ? "\n(allow network-outbound \(unixSocketsAllowedOnline.map { "(remote unix-socket (literal \"\($0)\"))" }.joined(separator: " ")))" : ""
    let addresses = network ? "" : "\n(deny network-outbound (remote ip))"
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
