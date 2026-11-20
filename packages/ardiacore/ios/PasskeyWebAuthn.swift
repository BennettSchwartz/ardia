import CryptoKit
import Foundation

enum PasskeyBase64URL {
  static func encode(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func decode(_ text: String) -> Data? {
    guard text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
    var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let remainder = base64.count % 4
    if remainder == 1 { return nil }
    if remainder > 0 { base64 += String(repeating: "=", count: 4 - remainder) }
    return Data(base64Encoded: base64)
  }
}

indirect enum PasskeyCBOR {
  case unsigned(UInt64)
  case negative(Int64)
  case bytes(Data)
  case text(String)
  case map([(PasskeyCBOR, PasskeyCBOR)])

  var encoded: Data {
    var out = Data()
    append(to: &out)
    return out
  }

  private static func head(_ major: UInt8, _ value: UInt64, into out: inout Data) {
    let type = major << 5
    switch value {
    case 0..<24: out.append(type | UInt8(value))
    case 24...0xFF: out.append(contentsOf: [type | 24, UInt8(value)])
    case 0x100...0xFFFF: out.append(type | 25); out.append(contentsOf: withUnsafeBytes(of: UInt16(value).bigEndian, Array.init))
    case 0x10000...0xFFFF_FFFF: out.append(type | 26); out.append(contentsOf: withUnsafeBytes(of: UInt32(value).bigEndian, Array.init))
    default: out.append(type | 27); out.append(contentsOf: withUnsafeBytes(of: value.bigEndian, Array.init))
    }
  }

  private func append(to out: inout Data) {
    switch self {
    case .unsigned(let value): Self.head(0, value, into: &out)
    case .negative(let value): Self.head(1, UInt64(-1 - value), into: &out)
    case .bytes(let data): Self.head(2, UInt64(data.count), into: &out); out.append(data)
    case .text(let text):
      let utf8 = Data(text.utf8)
      Self.head(3, UInt64(utf8.count), into: &out)
      out.append(utf8)
    case .map(let pairs):
      Self.head(5, UInt64(pairs.count), into: &out)
      for (key, value) in pairs {
        key.append(to: &out)
        value.append(to: &out)
      }
    }
  }
}

struct PasskeyFlags: OptionSet {
  let rawValue: UInt8
  static let userPresent = PasskeyFlags(rawValue: 0x01)
  static let userVerified = PasskeyFlags(rawValue: 0x04)
  static let backupEligible = PasskeyFlags(rawValue: 0x08)
  static let backedUp = PasskeyFlags(rawValue: 0x10)
  static let attestedCredentialData = PasskeyFlags(rawValue: 0x40)
}

enum PasskeyKeyError: Error, Equatable {
  case notP256
  case publicKeyMismatch
}

enum PasskeyWebAuthn {
  static let es256: Int64 = -7
  static let zeroAAGUID = Data(count: 16)

  static func coseKey(x963 publicKey: Data) -> Data {
    let x = publicKey.subdata(in: 1..<33)
    let y = publicKey.subdata(in: 33..<65)
    return PasskeyCBOR.map([
      (.unsigned(1), .unsigned(2)),
      (.unsigned(3), .negative(es256)),
      (.negative(-1), .unsigned(1)),
      (.negative(-2), .bytes(x)),
      (.negative(-3), .bytes(y)),
    ]).encoded
  }

  static func authenticatorData(rpId: String, flags: PasskeyFlags, credentialId: Data? = nil, publicKey: Data? = nil) -> Data {
    var data = Data(SHA256.hash(data: Data(rpId.utf8)))
    var all = flags
    if credentialId != nil { all.insert(.attestedCredentialData) }
    data.append(all.rawValue)
    data.append(contentsOf: [0, 0, 0, 0])
    if let credentialId, let publicKey {
      data.append(zeroAAGUID)
      data.append(contentsOf: [UInt8(credentialId.count >> 8), UInt8(credentialId.count & 0xFF)])
      data.append(credentialId)
      data.append(coseKey(x963: publicKey))
    }
    return data
  }

  static func attestationObject(authenticatorData: Data) -> Data {
    PasskeyCBOR.map([
      (.text("fmt"), .text("none")),
      (.text("attStmt"), .map([])),
      (.text("authData"), .bytes(authenticatorData)),
    ]).encoded
  }

  static func clientDataJSON(type: String, challenge: Data, origin: String) -> Data {
    let fields = [
      "\"type\":\(jsonString(type))",
      "\"challenge\":\(jsonString(PasskeyBase64URL.encode(challenge)))",
      "\"origin\":\(jsonString(origin))",
      "\"crossOrigin\":false",
    ]
    return Data("{\(fields.joined(separator: ","))}".utf8)
  }

  static func signedPayload(authenticatorData: Data, clientDataJSON: Data) -> Data {
    authenticatorData + Data(SHA256.hash(data: clientDataJSON))
  }

  static func importableKey(pkcs8: Data, expectedPublicKey: Data? = nil) throws -> (privateX963: Data, publicX963: Data) {
    guard let key = try? P256.Signing.PrivateKey(derRepresentation: pkcs8) else { throw PasskeyKeyError.notP256 }
    let publicX963 = key.publicKey.x963Representation
    if let expectedPublicKey, !matches(expectedPublicKey, publicX963: publicX963) { throw PasskeyKeyError.publicKeyMismatch }
    return (key.x963Representation, publicX963)
  }

  private static func matches(_ supplied: Data, publicX963: Data) -> Bool {
    if supplied == publicX963 { return true }
    if let spki = try? P256.Signing.PublicKey(derRepresentation: supplied) { return spki.x963Representation == publicX963 }
    return false
  }

  private static func jsonString(_ value: String) -> String {
    var out = "\""
    for scalar in value.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) } else { out.unicodeScalars.append(scalar) }
      }
    }
    return out + "\""
  }
}
