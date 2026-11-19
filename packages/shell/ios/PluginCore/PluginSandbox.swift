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
    "com.apple.cfprefsd.agent", "com.apple.cfprefsd.daemon", "com.apple.FSEvents",
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

  static let certificateSourceLimit = 4 << 20

  struct NetworkEnvironment: Equatable {
    var variables: [String] = []
    var droppedProxies: [String] = []
    var certificates: String?
  }

  static func carriesCredentials(_ value: String) -> Bool {
    guard let url = URL(string: value.contains("://") ? value : "http://\(value)") else { return value.contains("@") }
    return url.user != nil || url.password != nil || (url.host == nil && value.contains("@"))
  }

  static func certificateBlocks(in text: String) -> [String] {
    let begin = "-----BEGIN CERTIFICATE-----"
    let end = "-----END CERTIFICATE-----"
    var blocks: [String] = []
    var rest = Substring(text)
    while let start = rest.range(of: begin), let stop = rest[start.upperBound...].range(of: end) {
      let body = rest[start.upperBound..<stop.lowerBound].filter { !$0.isWhitespace }
      rest = rest[stop.upperBound...]
      guard let der = Data(base64Encoded: String(body)), !der.isEmpty, der.first == 0x30 else { continue }
      blocks.append("\(begin)\n\(der.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed]))\n\(end)\n")
    }
    return blocks
  }

  static func certificateBundle(from given: [String: String], system: String = systemCertificates) -> String {
    var sources = [system]
    for name in certificateEnvironment {
      if let path = given[name], !path.isEmpty, !sources.contains(path) { sources.append(path) }
    }
    var seen = Set<String>()
    var bundle = ""
    for source in sources {
      guard let handle = FileHandle(forReadingAtPath: source) else { continue }
      defer { try? handle.close() }
      guard let data = try? handle.read(upToCount: certificateSourceLimit + 1), data.count <= certificateSourceLimit else { continue }
      for block in certificateBlocks(in: String(decoding: data, as: UTF8.self)) where seen.insert(block).inserted { bundle += block }
    }
    return bundle
  }

  static func certificateVariables(dataFolder: String) -> [String] {
    let bundle = (dataFolder as NSString).appendingPathComponent(certificateBundleName)
    return ["SSL_CERT_FILE=\(bundle)", "NODE_EXTRA_CA_CERTS=\(bundle)", "GIT_SSL_CAINFO=\(bundle)"]
  }

  static func networkEnvironment(from given: [String: String], network: Bool, system: String = systemCertificates) -> NetworkEnvironment {
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
    let bundle = certificateBundle(from: given, system: system)
    result.certificates = bundle.isEmpty ? nil : bundle
    return result
  }

  static func writeAtomically(in directory: Int32, name: String, contents: String) -> Bool {
    let temporary = ".\(name).\(UUID().uuidString)"
    let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o644)
    guard fd >= 0 else { return false }
    let bytes = Array(contents.utf8)
    var written = 0
    while written < bytes.count {
      let step = bytes[written...].withUnsafeBufferPointer { Darwin.write(fd, $0.baseAddress, $0.count) }
      if step <= 0 { break }
      written += step
    }
    let complete = written == bytes.count && fchmod(fd, 0o644) == 0
    Darwin.close(fd)
    guard complete, renameat(directory, temporary, directory, name) == 0 else {
      unlinkat(directory, temporary, 0)
      return false
    }
    return true
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
      (deny network-bind (local unix-socket))
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
    if Self.unreadableTrees.contains(where: { Self.overlaps($0, folder) }) && !readable(folder) { return program }
    return folder
  }

  func readable(_ folder: String) -> Bool {
    Self.isInside(folder, pluginFolder)
  }

  static func ancestors(of path: String, below home: String) -> [String] {
    var chain: [String] = []
    var current = (path as NSString).deletingLastPathComponent
    while isInside(current, home) && current != home {
      chain.append(current)
      current = (current as NSString).deletingLastPathComponent
    }
    return chain
  }

  func pathRules() -> (text: String, parameters: [String: String]) {
    var text = ""
    var parameters: [String: String] = [:]
    let roots = [home, appData, configFolder]
    let chain = Set([pluginFolder, program, pluginData].flatMap { path in roots.filter { Self.isInside(path, $0) }.flatMap { Self.ancestors(of: path, below: $0) + [$0] } })
    for (step, folder) in chain.sorted().enumerated() {
      let name = "PATH_UP_\(step)"
      parameters[name] = folder
      text += "\n(allow file-read-metadata (literal (param \"\(name)\")))"
    }
    return (text, parameters)
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
    let paths = pathRules()
    let parameters = [
      "HOME": home, "APP_DATA": appData, "CONFIG": configFolder, "PLUGIN": pluginFolder, "DATA": pluginData, "PROGRAM": program,
      "INSTALL": installFolder(),
    ].merging(paths.parameters) { first, _ in first }
    return ["-p", Self.profile(network: network) + paths.text] + parameters.sorted { $0.key < $1.key }.flatMap { ["-D", "\($0.key)=\($0.value)"] }
  }
}
