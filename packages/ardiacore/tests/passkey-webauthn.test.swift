import CryptoKit
import Foundation

var failures = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
  if !condition() {
    failures += 1
    print("FAIL line \(line): \(message)")
  }
}
func rejects(_ expected: PasskeyRelyingPartyError, _ body: () throws -> Any, _ message: String, line: Int = #line) {
  do {
    _ = try body()
    check(false, "\(message): accepted", line: line)
  } catch let error as PasskeyRelyingPartyError {
    check(error == expected, "\(message): \(error) instead of \(expected)", line: line)
  } catch {
    check(false, "\(message): \(error)", line: line)
  }
}

let pslPath = CommandLine.arguments[1]
let suffixes = PasskeyPublicSuffixList(text: try! String(contentsOfFile: pslPath, encoding: .utf8))

check(suffixes.isPublicSuffix("com"), "com is a public suffix")
check(suffixes.isPublicSuffix("co.uk"), "co.uk is a public suffix")
check(suffixes.isPublicSuffix("github.io"), "github.io is a private-registry public suffix")
check(!suffixes.isPublicSuffix("example.com"), "example.com is registrable")
check(suffixes.registrableDomain(of: "a.b.example.co.uk") == "example.co.uk", "registrable domain under co.uk")
check(suffixes.registrableDomain(of: "me.github.io") == "me.github.io", "registrable domain under github.io")
check(suffixes.isPublicSuffix("anything.ck"), "wildcard *.ck")
check(!suffixes.isPublicSuffix("www.ck"), "exception !www.ck")

let github = try! PasskeyOrigin.parse("https://github.com")
check(try! PasskeyRelyingParty.validate(rpId: nil, origin: github, suffixes: suffixes) == "github.com", "rpId defaults to host")
let login = try! PasskeyOrigin.parse("https://login.example.co.uk:8443")
check(login.serialized == "https://login.example.co.uk:8443", "origin keeps its port")
check(try! PasskeyRelyingParty.validate(rpId: "example.co.uk", origin: login, suffixes: suffixes) == "example.co.uk", "registrable suffix allowed")
check(try! PasskeyRelyingParty.validate(rpId: "EXAMPLE.co.uk", origin: login, suffixes: suffixes) == "example.co.uk", "rpId is lowercased")
rejects(.publicSuffix, { try PasskeyRelyingParty.validate(rpId: "co.uk", origin: login, suffixes: suffixes) }, "public suffix rpId")
rejects(.badRelyingParty, { try PasskeyRelyingParty.validate(rpId: "evil.com", origin: github, suffixes: suffixes) }, "unrelated rpId")
rejects(.badRelyingParty, { try PasskeyRelyingParty.validate(rpId: "hub.com", origin: github, suffixes: suffixes) }, "suffix without a dot boundary")
rejects(.publicSuffix, { try PasskeyRelyingParty.validate(rpId: "github.io", origin: try PasskeyOrigin.parse("https://me.github.io"), suffixes: suffixes) }, "private registry")
rejects(.insecureOrigin, { try PasskeyOrigin.parse("http://example.com") }, "plain http")
rejects(.insecureOrigin, { try PasskeyOrigin.parse("http://127.0.0.1") }, "loopback ip over http")
rejects(.opaqueOrigin, { try PasskeyOrigin.parse("null") }, "opaque origin")
rejects(.opaqueOrigin, { try PasskeyOrigin.parse("file:///tmp/x") }, "file origin")
rejects(.addressLiteral, { try PasskeyRelyingParty.validate(rpId: nil, origin: try PasskeyOrigin.parse("https://10.0.0.1"), suffixes: suffixes) }, "ip origin")
let localhost = try! PasskeyOrigin.parse("http://localhost:3000")
check(try! PasskeyRelyingParty.validate(rpId: nil, origin: localhost, suffixes: suffixes) == "localhost", "localhost for development")
let idn = try! PasskeyOrigin.parse("https://xn--bcher-kva.example")
check(try! PasskeyRelyingParty.validate(rpId: "bücher.example", origin: idn, suffixes: suffixes) == "xn--bcher-kva.example", "unicode rpId is normalised to punycode")
check(PasskeyRelyingParty.isStorable(rpId: "github.com", suffixes: suffixes), "storable rpId")
check(!PasskeyRelyingParty.isStorable(rpId: "com", suffixes: suffixes), "suffix not storable")
check(!PasskeyRelyingParty.isStorable(rpId: "192.168.1.1", suffixes: suffixes), "ip not storable")

check(PasskeyBase64URL.encode(Data([0xfb, 0xff, 0xfe])) == "-__-", "base64url alphabet without padding")
check(PasskeyBase64URL.decode("-__-") == Data([0xfb, 0xff, 0xfe]), "base64url decodes")
check(PasskeyBase64URL.decode("a+b/") == nil, "standard base64 characters are refused")

check(PasskeyCBOR.unsigned(500).encoded == Data([0x19, 0x01, 0xf4]), "cbor uint16")
check(PasskeyCBOR.negative(-7).encoded == Data([0x26]), "cbor -7")
check(PasskeyCBOR.text("fmt").encoded == Data([0x63, 0x66, 0x6d, 0x74]), "cbor text")

let challenge = Data((0..<32).map { UInt8($0) })
let clientData = PasskeyWebAuthn.clientDataJSON(type: "webauthn.get", challenge: challenge, origin: "https://github.com")
let clientDataText = String(data: clientData, encoding: .utf8)!
check(clientDataText == "{\"type\":\"webauthn.get\",\"challenge\":\"\(PasskeyBase64URL.encode(challenge))\",\"origin\":\"https://github.com\",\"crossOrigin\":false}", "clientDataJSON member order and content")
let parsed = try! JSONSerialization.jsonObject(with: clientData) as! [String: Any]
check(parsed["crossOrigin"] as? Bool == false, "clientDataJSON parses")

let key = P256.Signing.PrivateKey()
let imported = try! PasskeyWebAuthn.importableKey(pkcs8: key.derRepresentation, expectedPublicKey: key.publicKey.derRepresentation)
check(imported.privateX963 == key.x963Representation && imported.privateX963.count == 97, "pkcs8 becomes 04||X||Y||K")
check(imported.publicX963 == key.publicKey.x963Representation, "public point derived")
do {
  _ = try PasskeyWebAuthn.importableKey(pkcs8: key.derRepresentation, expectedPublicKey: P256.Signing.PrivateKey().publicKey.x963Representation)
  check(false, "mismatched public key accepted")
} catch { check(error as? PasskeyKeyError == .publicKeyMismatch, "mismatched public key refused") }
do {
  _ = try PasskeyWebAuthn.importableKey(pkcs8: P384.Signing.PrivateKey().derRepresentation)
  check(false, "p384 accepted")
} catch { check(error as? PasskeyKeyError == .notP256, "p384 refused") }

let credentialId = Data((0..<16).map { UInt8(200 + $0 % 50) })
let created = PasskeyWebAuthn.authenticatorData(rpId: "github.com", flags: [.userPresent, .userVerified], credentialId: credentialId, publicKey: imported.publicX963)
check(created.prefix(32) == Data(SHA256.hash(data: Data("github.com".utf8))), "rpIdHash")
check(created[32] == 0x45, "create flags UP|UV|AT and no backup bits")
check(created.subdata(in: 33..<37) == Data(count: 4), "sign counter is zero")
check(created.subdata(in: 37..<53) == Data(count: 16), "zero aaguid")
check(created.subdata(in: 53..<55) == Data([0, 16]), "credential id length")
check(created.subdata(in: 55..<71) == credentialId, "credential id")
let cose = created.subdata(in: 71..<created.count)
check(cose.prefix(7) == Data([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01]), "cose ec2 p-256 es256 header")
check(cose.count == 77, "cose key length")

let assertion = PasskeyWebAuthn.authenticatorData(rpId: "github.com", flags: [.userPresent, .userVerified, .backupEligible])
check(assertion.count == 37 && assertion[32] == 0x0d, "imported assertion flags UP|UV|BE, BS clear")
let signature = try! key.signature(for: PasskeyWebAuthn.signedPayload(authenticatorData: assertion, clientDataJSON: clientData))
let verified = key.publicKey.isValidSignature(try! P256.Signing.ECDSASignature(derRepresentation: signature.derRepresentation), for: assertion + Data(SHA256.hash(data: clientData)))
check(verified, "assertion signature verifies over authData || SHA-256(clientDataJSON)")

let attestation = PasskeyWebAuthn.attestationObject(authenticatorData: created)
check(attestation.prefix(1) == Data([0xa3]), "attestation object is a 3-entry map")
check(attestation.range(of: Data("none".utf8)) != nil, "fmt none")

if failures > 0 {
  print("\(failures) failure(s)")
  exit(1)
}
print("passkey webauthn: all checks passed")
