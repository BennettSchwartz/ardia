import Foundation
import LocalAuthentication
import Security

enum PasskeyLimits {
  static let challengeBytes = 1024
  static let descriptors = 64
  static let userFieldBytes = 256
  static let credentialIdBytes = 1023
}

enum PasskeyFallThrough: String, Equatable {
  case noProvider
  case noCredential
  case unsupported
  case crossPlatform
  case noES256
  case conditional
  case createOff
  case badRequest
  case relyingParty
}

struct PasskeyGetOptions {
  let challenge: Data
  let rpId: String?
  let allowCredentials: [Data]
  let mediation: String?

  static func parse(_ json: [String: Any]) -> PasskeyGetOptions? {
    guard let publicKey = json["publicKey"] as? [String: Any], let challenge = (publicKey["challenge"] as? String).flatMap(PasskeyBase64URL.decode),
      !challenge.isEmpty, challenge.count <= PasskeyLimits.challengeBytes
    else { return nil }
    let allow = (publicKey["allowCredentials"] as? [[String: Any]]) ?? []
    guard allow.count <= PasskeyLimits.descriptors else { return nil }
    let ids = allow.compactMap { ($0["id"] as? String).flatMap(PasskeyBase64URL.decode) }.filter { $0.count <= PasskeyLimits.credentialIdBytes }
    guard ids.count == allow.count else { return nil }
    return PasskeyGetOptions(challenge: challenge, rpId: publicKey["rpId"] as? String, allowCredentials: ids, mediation: json["mediation"] as? String)
  }
}

struct PasskeyCreateOptions {
  let challenge: Data
  let rpId: String?
  let userId: Data
  let userName: String
  let userDisplayName: String
  let algorithms: [Int]
  let excludeCredentials: [Data]
  let attachment: String?
  let credProps: Bool
  let mediation: String?

  static func parse(_ json: [String: Any]) -> PasskeyCreateOptions? {
    guard let publicKey = json["publicKey"] as? [String: Any], let challenge = (publicKey["challenge"] as? String).flatMap(PasskeyBase64URL.decode),
      !challenge.isEmpty, challenge.count <= PasskeyLimits.challengeBytes, let user = publicKey["user"] as? [String: Any],
      let userId = (user["id"] as? String).flatMap(PasskeyBase64URL.decode), (1...64).contains(userId.count)
    else { return nil }
    let name = user["name"] as? String ?? ""
    let displayName = user["displayName"] as? String ?? ""
    guard name.utf8.count <= PasskeyLimits.userFieldBytes, displayName.utf8.count <= PasskeyLimits.userFieldBytes else { return nil }
    let rp = publicKey["rp"] as? [String: Any]
    let params = (publicKey["pubKeyCredParams"] as? [[String: Any]]) ?? []
    let exclude = (publicKey["excludeCredentials"] as? [[String: Any]]) ?? []
    guard exclude.count <= PasskeyLimits.descriptors else { return nil }
    let excluded = exclude.compactMap { ($0["id"] as? String).flatMap(PasskeyBase64URL.decode) }
    guard excluded.count == exclude.count else { return nil }
    let selection = publicKey["authenticatorSelection"] as? [String: Any]
    let extensions = publicKey["extensions"] as? [String: Any]
    return PasskeyCreateOptions(
      challenge: challenge, rpId: rp?["id"] as? String, userId: userId, userName: name, userDisplayName: displayName,
      algorithms: params.compactMap { ($0["alg"] as? NSNumber)?.intValue }, excludeCredentials: excluded,
      attachment: selection?["authenticatorAttachment"] as? String, credProps: extensions?["credProps"] as? Bool == true,
      mediation: json["mediation"] as? String)
  }
}

enum PasskeyGetPlan: Equatable {
  case fallThrough(PasskeyFallThrough)
  case choose(rpId: String, credentials: [PasskeyCredential])
}

enum PasskeyCreatePlan: Equatable {
  case fallThrough(PasskeyFallThrough)
  case excluded(rpId: String)
  case offer(rpId: String)
}

struct PasskeyPolicy: Equatable {
  let groupId: String
  let create: Bool
  let privateWindow: Bool
  var profile: String = ""
}

final class PasskeyAuthenticator {
  let store: PasskeyKeyStore
  let suffixes: PasskeyPublicSuffixList

  init(store: PasskeyKeyStore, suffixes: PasskeyPublicSuffixList) {
    self.store = store
    self.suffixes = suffixes
  }

  private func relyingParty(_ requested: String?, origin: String) -> (PasskeyOrigin, String)? {
    guard let parsed = try? PasskeyOrigin.parse(origin), let rpId = try? PasskeyRelyingParty.validate(rpId: requested, origin: parsed, suffixes: suffixes)
    else { return nil }
    return (parsed, rpId)
  }

  func planGet(_ options: PasskeyGetOptions, origin: String, policy: PasskeyPolicy?) -> PasskeyGetPlan {
    guard let policy else { return .fallThrough(.noProvider) }
    if let mediation = options.mediation, mediation == "conditional" || mediation == "silent" { return .fallThrough(.conditional) }
    guard let (_, rpId) = relyingParty(options.rpId, origin: origin) else { return .fallThrough(.relyingParty) }
    let stored = (try? store.credentials(groupId: policy.groupId, rpId: rpId)) ?? []
    let matching = options.allowCredentials.isEmpty ? stored : stored.filter { options.allowCredentials.contains($0.credentialId) }
    return matching.isEmpty ? .fallThrough(.noCredential) : .choose(rpId: rpId, credentials: matching)
  }

  func planCreate(_ options: PasskeyCreateOptions, origin: String, policy: PasskeyPolicy?) -> PasskeyCreatePlan {
    guard let policy else { return .fallThrough(.noProvider) }
    guard policy.create, !policy.privateWindow else { return .fallThrough(.createOff) }
    if let mediation = options.mediation, mediation == "conditional" { return .fallThrough(.conditional) }
    if options.attachment == "cross-platform" { return .fallThrough(.crossPlatform) }
    guard options.algorithms.isEmpty || options.algorithms.contains(Int(PasskeyWebAuthn.es256)) else { return .fallThrough(.noES256) }
    guard let (_, rpId) = relyingParty(options.rpId, origin: origin) else { return .fallThrough(.relyingParty) }
    let stored = (try? store.credentials(groupId: policy.groupId, rpId: rpId)) ?? []
    if stored.contains(where: { options.excludeCredentials.contains($0.credentialId) }) { return .excluded(rpId: rpId) }
    return .offer(rpId: rpId)
  }

  func assertion(_ credential: PasskeyCredential, options: PasskeyGetOptions, origin: String, context: LAContext?) throws -> [String: Any] {
    guard let (parsed, rpId) = relyingParty(options.rpId, origin: origin), rpId == credential.rpId else { throw PasskeyStoreError.missingKey }
    var flags: PasskeyFlags = [.userPresent, .userVerified]
    if credential.backupEligible { flags.insert(.backupEligible) }
    let authenticatorData = PasskeyWebAuthn.authenticatorData(rpId: rpId, flags: flags)
    let clientData = PasskeyWebAuthn.clientDataJSON(type: "webauthn.get", challenge: options.challenge, origin: parsed.serialized)
    let signature = try store.sign(credential, payload: PasskeyWebAuthn.signedPayload(authenticatorData: authenticatorData, clientDataJSON: clientData), context: context)
    return [
      "id": PasskeyBase64URL.encode(credential.credentialId),
      "rawId": PasskeyBase64URL.encode(credential.credentialId),
      "type": "public-key",
      "authenticatorAttachment": "platform",
      "response": [
        "clientDataJSON": PasskeyBase64URL.encode(clientData),
        "authenticatorData": PasskeyBase64URL.encode(authenticatorData),
        "signature": PasskeyBase64URL.encode(signature),
        "userHandle": PasskeyBase64URL.encode(credential.userHandle),
      ],
      "clientExtensionResults": [String: Any](),
    ]
  }

  func registration(_ options: PasskeyCreateOptions, origin: String, policy: PasskeyPolicy, verifiedOwner: Bool) throws -> [String: Any] {
    guard verifiedOwner, let (parsed, rpId) = relyingParty(options.rpId, origin: origin) else { throw PasskeyStoreError.cancelled }
    var credentialId = Data(count: 16)
    let status = credentialId.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
    guard status == errSecSuccess else { throw PasskeyStoreError.keychain(status) }
    let credential = PasskeyCredential(
      groupId: policy.groupId, rpId: rpId, credentialId: credentialId, userHandle: options.userId, userName: options.userName,
      userDisplayName: options.userDisplayName, created: Date(), source: .ardia, backupEligible: false, ready: false)
    let publicX963 = try store.generate(credential)
    let authenticatorData = PasskeyWebAuthn.authenticatorData(
      rpId: rpId, flags: [.userPresent, .userVerified], credentialId: credentialId, publicKey: publicX963)
    let clientData = PasskeyWebAuthn.clientDataJSON(type: "webauthn.create", challenge: options.challenge, origin: parsed.serialized)
    var extensions: [String: Any] = [:]
    if options.credProps { extensions["credProps"] = ["rk": true] }
    return [
      "id": PasskeyBase64URL.encode(credentialId),
      "rawId": PasskeyBase64URL.encode(credentialId),
      "type": "public-key",
      "authenticatorAttachment": "platform",
      "response": [
        "clientDataJSON": PasskeyBase64URL.encode(clientData),
        "attestationObject": PasskeyBase64URL.encode(PasskeyWebAuthn.attestationObject(authenticatorData: authenticatorData)),
        "authenticatorData": PasskeyBase64URL.encode(authenticatorData),
        "publicKey": PasskeyBase64URL.encode(PasskeyWebAuthn.subjectPublicKeyInfo(x963: publicX963)),
        "publicKeyAlgorithm": PasskeyWebAuthn.es256,
        "transports": ["internal"],
      ],
      "clientExtensionResults": extensions,
    ]
  }
}
