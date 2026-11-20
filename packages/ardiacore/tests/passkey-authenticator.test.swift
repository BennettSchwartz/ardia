import CryptoKit
import Foundation

var failures = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
  if !condition() {
    failures += 1
    print("FAIL line \(line): \(message)")
  }
}

let suffixes = PasskeyPublicSuffixList(text: try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8))
let store = PasskeyTestStore()
let authenticator = PasskeyAuthenticator(store: store, suffixes: suffixes)
let policy = PasskeyPolicy(groupId: "personal", create: true, privateWindow: false)
let b64 = PasskeyBase64URL.encode

let appleKey = P256.Signing.PrivateKey()
let appleId = Data((1...20).map { UInt8($0) })
let apple = PasskeyCredential(
  groupId: "personal", rpId: "github.com", credentialId: appleId, userHandle: Data("user-1".utf8), userName: "octo",
  userDisplayName: "Octo Cat", created: Date(timeIntervalSince1970: 1), source: .apple, backupEligible: true, ready: false)
check(try! store.add(apple, privateX963: appleKey.x963Representation) == .added, "first import adds")
check(try! store.add(apple, privateX963: appleKey.x963Representation) == .existing, "re-import of the same credential id is skipped")
let otherGroup = PasskeyCredential(
  groupId: "work", rpId: "github.com", credentialId: appleId, userHandle: Data("user-1".utf8), userName: "octo",
  userDisplayName: "Octo Cat", created: Date(timeIntervalSince1970: 2), source: .apple, backupEligible: true, ready: false)
check(try! store.add(otherGroup, privateX963: appleKey.x963Representation) == .added, "the same credential in another group is its own entry")
check(apple.locator != otherGroup.locator, "locators are scoped per group")

let challenge = Data(repeating: 7, count: 32)
func getJSON(rpId: String? = nil, allow: [Data] = [], mediation: String? = nil) -> [String: Any] {
  var publicKey: [String: Any] = ["challenge": b64(challenge)]
  if let rpId { publicKey["rpId"] = rpId }
  if !allow.isEmpty { publicKey["allowCredentials"] = allow.map { ["type": "public-key", "id": b64($0)] } }
  var json: [String: Any] = ["publicKey": publicKey]
  if let mediation { json["mediation"] = mediation }
  return json
}

let discoverable = PasskeyGetOptions.parse(getJSON())!
check(authenticator.planGet(discoverable, origin: "https://github.com", policy: nil) == .fallThrough(.noProvider), "no provider falls through")
guard case .choose(let rpId, let offered) = authenticator.planGet(discoverable, origin: "https://github.com", policy: policy) else {
  print("FAIL: discoverable get not offered")
  exit(1)
}
check(rpId == "github.com" && offered.count == 1 && offered[0].groupId == "personal", "discoverable get offers this group's passkey only")
check(authenticator.planGet(PasskeyGetOptions.parse(getJSON(allow: [Data([9, 9])]))!, origin: "https://github.com", policy: policy) == .fallThrough(.noCredential), "allowCredentials without a match falls through")
if case .choose(_, let matched) = authenticator.planGet(PasskeyGetOptions.parse(getJSON(allow: [Data([9]), appleId]))!, origin: "https://github.com", policy: policy) {
  check(matched.map(\.credentialId) == [appleId], "allowCredentials matches byte for byte")
} else { check(false, "allowCredentials with a match is offered") }
check(authenticator.planGet(discoverable, origin: "https://gitlab.com", policy: policy) == .fallThrough(.noCredential), "another site has no passkey")
check(authenticator.planGet(PasskeyGetOptions.parse(getJSON(rpId: "github.com"))!, origin: "https://evil.com", policy: policy) == .fallThrough(.relyingParty), "foreign rpId falls through")
check(authenticator.planGet(PasskeyGetOptions.parse(getJSON(mediation: "conditional"))!, origin: "https://github.com", policy: policy) == .fallThrough(.conditional), "conditional falls through")
check(authenticator.planGet(discoverable, origin: "http://github.com", policy: policy) == .fallThrough(.relyingParty), "insecure origin falls through")
check(PasskeyGetOptions.parse(["publicKey": ["challenge": b64(Data(count: 2000))]]) == nil, "oversized challenge refused")
check(PasskeyGetOptions.parse(["publicKey": ["challenge": "not base64!"]]) == nil, "bad challenge refused")

let response = try! authenticator.assertion(offered[0], options: discoverable, origin: "https://github.com", context: nil)
let inner = response["response"] as! [String: Any]
let authData = PasskeyBase64URL.decode(inner["authenticatorData"] as! String)!
let clientData = PasskeyBase64URL.decode(inner["clientDataJSON"] as! String)!
let signature = try! P256.Signing.ECDSASignature(derRepresentation: PasskeyBase64URL.decode(inner["signature"] as! String)!)
check(authData[32] == 0x0d, "imported passkey asserts UP|UV|BE with BS clear")
check(authData.subdata(in: 33..<37) == Data(count: 4), "counter stays zero")
check(appleKey.publicKey.isValidSignature(signature, for: authData + Data(SHA256.hash(data: clientData))), "assertion verifies with the imported public key")
check(PasskeyBase64URL.decode(inner["userHandle"] as! String) == Data("user-1".utf8), "user handle returned")
check(response["id"] as? String == b64(appleId) && response["type"] as? String == "public-key", "id and type")
let client = try! JSONSerialization.jsonObject(with: clientData) as! [String: Any]
check(client["origin"] as? String == "https://github.com" && client["type"] as? String == "webauthn.get", "client data origin is native")
check((try? authenticator.assertion(offered[0], options: discoverable, origin: "https://gitlab.com", context: nil)) == nil, "assertion refuses a credential for another rp")

func createJSON(rpId: String? = nil, algs: [Int] = [-7, -257], exclude: [Data] = [], attachment: String? = nil) -> [String: Any] {
  var publicKey: [String: Any] = [
    "challenge": b64(challenge), "rp": ["name": "Example"], "user": ["id": b64(Data("u-9".utf8)), "name": "ann", "displayName": "Ann"],
    "pubKeyCredParams": algs.map { ["type": "public-key", "alg": $0] }, "extensions": ["credProps": true],
  ]
  if let rpId { publicKey["rp"] = ["id": rpId, "name": "Example"] }
  if !exclude.isEmpty { publicKey["excludeCredentials"] = exclude.map { ["type": "public-key", "id": b64($0)] } }
  if let attachment { publicKey["authenticatorSelection"] = ["authenticatorAttachment": attachment] }
  return ["publicKey": publicKey]
}
let createOptions = PasskeyCreateOptions.parse(createJSON())!
check(authenticator.planCreate(createOptions, origin: "https://example.com", policy: policy) == .offer(rpId: "example.com"), "create offered")
check(authenticator.planCreate(createOptions, origin: "https://example.com", policy: PasskeyPolicy(groupId: "personal", create: false, privateWindow: false)) == .fallThrough(.createOff), "create off")
check(authenticator.planCreate(createOptions, origin: "https://example.com", policy: PasskeyPolicy(groupId: "personal", create: true, privateWindow: true)) == .fallThrough(.createOff), "no create in private windows")
check(authenticator.planCreate(PasskeyCreateOptions.parse(createJSON(algs: [-257]))!, origin: "https://example.com", policy: policy) == .fallThrough(.noES256), "rsa only falls through")
check(authenticator.planCreate(PasskeyCreateOptions.parse(createJSON(attachment: "cross-platform"))!, origin: "https://example.com", policy: policy) == .fallThrough(.crossPlatform), "security key request falls through")
check(authenticator.planCreate(PasskeyCreateOptions.parse(createJSON(exclude: [appleId]))!, origin: "https://github.com", policy: policy) == .excluded(rpId: "github.com"), "excludeCredentials match")
check((try? authenticator.registration(createOptions, origin: "https://example.com", policy: policy, verifiedOwner: false)) == nil, "no registration without owner verification")

let registered = try! authenticator.registration(createOptions, origin: "https://example.com", policy: policy, verifiedOwner: true)
let registeredResponse = registered["response"] as! [String: Any]
let createdAuthData = PasskeyBase64URL.decode(registeredResponse["authenticatorData"] as! String)!
check(createdAuthData[32] == 0x45, "created passkey is UP|UV|AT with no backup bits")
check(((registered["clientExtensionResults"] as! [String: Any])["credProps"] as? [String: Bool])?["rk"] == true, "credProps rk")
check(registeredResponse["publicKeyAlgorithm"] as? Int64 == -7, "es256")
let newId = PasskeyBase64URL.decode(registered["rawId"] as! String)!
let made = try! store.credentials(groupId: "personal", rpId: "example.com")
check(made.count == 1 && made[0].credentialId == newId && made[0].source == .ardia && !made[0].backupEligible, "created passkey stored as device-bound")
let spki = try! P256.Signing.PublicKey(derRepresentation: PasskeyBase64URL.decode(registeredResponse["publicKey"] as! String)!)
let followUp = PasskeyGetOptions.parse(getJSON(allow: [newId]))!
guard case .choose(_, let createdOffered) = authenticator.planGet(followUp, origin: "https://example.com", policy: policy) else {
  print("FAIL: created passkey not offered")
  exit(1)
}
let second = try! authenticator.assertion(createdOffered[0], options: followUp, origin: "https://example.com", context: nil)["response"] as! [String: Any]
let secondData = PasskeyBase64URL.decode(second["authenticatorData"] as! String)!
check(secondData[32] == 0x05, "created passkey asserts UP|UV only")
check(spki.isValidSignature(try! P256.Signing.ECDSASignature(derRepresentation: PasskeyBase64URL.decode(second["signature"] as! String)!),
  for: secondData + Data(SHA256.hash(data: PasskeyBase64URL.decode(second["clientDataJSON"] as! String)!))), "created passkey signs with the public key it reported")

check(try! store.deleteAll(groupId: "personal") == 2, "delete all removes this group's passkeys")
check(try! store.credentials(groupId: "work", rpId: nil).count == 1, "other groups keep theirs")

if failures > 0 {
  print("\(failures) failure(s)")
  exit(1)
}
print("passkey authenticator: all checks passed")
