import AuthenticationServices
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
let secret = "hunter2-fixture-password"
let github = P256.Signing.PrivateKey()
let google = P256.Signing.PrivateKey()

func field(_ value: String, _ type: ASImportableEditableField.FieldType) -> ASImportableEditableField {
  ASImportableEditableField(id: nil, fieldType: type, value: value)
}
func passkey(_ rp: String, _ id: UInt8, _ key: Data) -> ASImportableCredential {
  .passkey(ASImportableCredential.Passkey(
    credentialID: Data([id, id, id, id]), relyingPartyIdentifier: rp, userName: "octo", userDisplayName: "Octo", userHandle: Data("u\(id)".utf8), key: key))
}
func item(_ title: String, _ credentials: [ASImportableCredential]) -> ASImportableItem {
  ASImportableItem(id: Data(title.utf8), title: title, credentials: credentials)
}

let items = [
  item("GitHub", [passkey("GitHub.com", 1, github.derRepresentation), .basicAuthentication(.init(userName: field("octo", .string), password: field(secret, .concealedString)))]),
  item("Google", [passkey("accounts.google.com", 2, google.derRepresentation)]),
  item("Suffix", [passkey("co.uk", 3, P256.Signing.PrivateKey().derRepresentation)]),
  item("Address", [passkey("192.168.1.1", 4, P256.Signing.PrivateKey().derRepresentation)]),
  item("P384", [passkey("example.com", 5, P384.Signing.PrivateKey().derRepresentation)]),
  item("Mail", [.basicAuthentication(.init(userName: field("me", .string), password: field(secret, .concealedString)))]),
  item("Note", [.note(.init(content: field("a private note", .string)))]),
]
let export = ASExportedCredentialData(
  accounts: [ASImportableAccount(id: Data("acct".utf8), userName: "me", email: "me@example.com", collections: [], items: items)],
  formatVersion: .v1, exporterRelyingPartyIdentifier: "com.apple.Passwords", exporterDisplayName: "Passwords", timestamp: Date())

let store = PasskeyTestStore()
let first = PasskeyImport.keep(export, groupId: "personal", store: store, suffixes: suffixes)
check(first.items == 7 && first.passkeys == 5, "every item is seen once: \(first)")
check(first.added == 2, "the two valid passkeys are kept")
check(first.skippedRelyingParty == 2, "public-suffix and IP relying parties are skipped")
check(first.skippedAlgorithm == 1, "a non-P-256 key is skipped")
check(first.failed == 0, "nothing failed")
let stored = try! store.credentials(groupId: "personal", rpId: nil)
check(stored.map(\.rpId).sorted() == ["accounts.google.com", "github.com"], "rpIds stored lowercased")
check(stored.allSatisfy { $0.source == .apple && $0.backupEligible }, "imported passkeys are marked as copied and backup-eligible")
check(store.publicKey(stored.first { $0.rpId == "github.com" }!)?.x963Representation == github.publicKey.x963Representation, "the github key is the exported one")
let encoded = try! JSONEncoder().encode(stored)
check(String(data: encoded, encoding: .utf8)!.contains(secret) == false, "no password reaches the stored records")

let second = PasskeyImport.keep(export, groupId: "personal", store: store, suffixes: suffixes)
check(second.added == 0 && second.existing == 2, "a second import adds nothing: \(second)")
let otherGroup = PasskeyImport.keep(export, groupId: "work", store: store, suffixes: suffixes)
check(otherGroup.added == 2 && (try! store.credentials(groupId: "personal", rpId: nil)).count == 2, "another group gets its own copies")

if failures > 0 {
  print("\(failures) failure(s)")
  exit(1)
}
print("passkey import: all checks passed")
