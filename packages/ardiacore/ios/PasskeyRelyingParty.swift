import Foundation

final class PasskeyPublicSuffixList {
  private let rules: Set<String>
  private let wildcards: Set<String>
  private let exceptions: Set<String>

  init(text: String) {
    var rules = Set<String>()
    var wildcards = Set<String>()
    var exceptions = Set<String>()
    for raw in text.split(whereSeparator: \.isNewline) {
      let line = raw.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
      if line.isEmpty || line.hasPrefix("//") { continue }
      let rule = Self.ascii(line.lowercased()) ?? line.lowercased()
      if rule.hasPrefix("!") { exceptions.insert(String(rule.dropFirst())) }
      else if rule.hasPrefix("*.") { wildcards.insert(String(rule.dropFirst(2))) }
      else { rules.insert(rule) }
    }
    self.rules = rules
    self.wildcards = wildcards
    self.exceptions = exceptions
  }

  static let bundled: PasskeyPublicSuffixList? = {
    let bundles = [Bundle(for: PasskeyPublicSuffixList.self), .main]
    for bundle in bundles {
      if let url = bundle.url(forResource: "public_suffix_list", withExtension: "dat"), let text = try? String(contentsOf: url, encoding: .utf8) {
        return PasskeyPublicSuffixList(text: text)
      }
    }
    return nil
  }()

  func publicSuffix(of host: String) -> String {
    let labels = host.split(separator: ".").map(String.init)
    for start in labels.indices {
      let candidate = labels[start...].joined(separator: ".")
      if exceptions.contains(candidate) { return labels[(start + 1)...].joined(separator: ".") }
      if rules.contains(candidate) { return candidate }
      let parent = labels[(start + 1)...].joined(separator: ".")
      if start + 1 < labels.count, wildcards.contains(parent) { return candidate }
    }
    return labels.last ?? host
  }

  func isPublicSuffix(_ host: String) -> Bool { publicSuffix(of: host) == host }

  func registrableDomain(of host: String) -> String? {
    let suffix = publicSuffix(of: host)
    guard host != suffix, host.hasSuffix("." + suffix) else { return nil }
    let rest = host.dropLast(suffix.count + 1)
    let label = rest.split(separator: ".").last.map(String.init) ?? String(rest)
    return label + "." + suffix
  }

  static func ascii(_ host: String) -> String? {
    if host.allSatisfy(\.isASCII) { return host }
    var components = URLComponents()
    components.scheme = "https"
    components.host = host
    return components.url?.host(percentEncoded: true)
  }
}

enum PasskeyRelyingPartyError: Error, Equatable {
  case insecureOrigin
  case opaqueOrigin
  case badRelyingParty
  case publicSuffix
  case addressLiteral
}

struct PasskeyOrigin: Equatable {
  let serialized: String
  let host: String

  static func parse(_ origin: String) throws -> PasskeyOrigin {
    guard origin != "null", let url = URL(string: origin), let scheme = url.scheme?.lowercased(), let rawHost = url.host(percentEncoded: true)
    else { throw PasskeyRelyingPartyError.opaqueOrigin }
    let host = rawHost.lowercased()
    guard url.path.isEmpty || url.path == "/", url.query == nil, url.fragment == nil, url.user == nil else { throw PasskeyRelyingPartyError.opaqueOrigin }
    switch scheme {
    case "https": break
    case "http" where host == "localhost": break
    default: throw PasskeyRelyingPartyError.insecureOrigin
    }
    let port = url.port.map { ":\($0)" } ?? ""
    return PasskeyOrigin(serialized: "\(scheme)://\(host)\(port)", host: host)
  }
}

enum PasskeyRelyingParty {
  static let maxHostLength = 253

  static func isAddressLiteral(_ host: String) -> Bool {
    if host.hasPrefix("[") || host.contains(":") { return true }
    let parts = host.split(separator: ".", omittingEmptySubsequences: false)
    return parts.count == 4 && parts.allSatisfy { part in UInt8(part) != nil }
  }

  static func normalized(_ rpId: String) -> String? {
    let lower = rpId.lowercased()
    guard !lower.isEmpty, lower.count <= maxHostLength, !lower.hasPrefix("."), !lower.hasSuffix("."), !lower.contains("..") else { return nil }
    return PasskeyPublicSuffixList.ascii(lower)
  }

  static func validate(rpId requested: String?, origin: PasskeyOrigin, suffixes: PasskeyPublicSuffixList) throws -> String {
    if isAddressLiteral(origin.host) { throw PasskeyRelyingPartyError.addressLiteral }
    guard let rpId = normalized(requested ?? origin.host) else { throw PasskeyRelyingPartyError.badRelyingParty }
    if isAddressLiteral(rpId) { throw PasskeyRelyingPartyError.addressLiteral }
    guard rpId == origin.host || origin.host.hasSuffix("." + rpId) else { throw PasskeyRelyingPartyError.badRelyingParty }
    if rpId != "localhost", suffixes.isPublicSuffix(rpId) { throw PasskeyRelyingPartyError.publicSuffix }
    return rpId
  }

  static func isStorable(rpId: String, suffixes: PasskeyPublicSuffixList) -> Bool {
    guard let normalizedId = normalized(rpId), normalizedId == rpId.lowercased() else { return false }
    return !isAddressLiteral(normalizedId) && !suffixes.isPublicSuffix(normalizedId)
  }
}
