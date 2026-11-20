import AuthenticationServices
import Foundation

struct PasskeyImportCounts: Codable, Equatable {
  var items = 0
  var passkeys = 0
  var added = 0
  var existing = 0
  var repaired = 0
  var skippedRelyingParty = 0
  var skippedAlgorithm = 0
  var failed = 0

  var kept: Int { added + repaired }
}

@available(macOS 26.0, *)
enum PasskeyImport {
  static func keep(_ export: ASExportedCredentialData, groupId: String, store: PasskeyKeyStore, suffixes: PasskeyPublicSuffixList) -> PasskeyImportCounts {
    var counts = PasskeyImportCounts()
    for account in export.accounts {
      for item in account.items {
        counts.items += 1
        for credential in item.credentials {
          guard case .passkey(let passkey) = credential else { continue }
          counts.passkeys += 1
          let rpId = passkey.relyingPartyIdentifier.lowercased()
          guard PasskeyRelyingParty.isStorable(rpId: rpId, suffixes: suffixes), !passkey.credentialID.isEmpty,
            passkey.credentialID.count <= PasskeyLimits.credentialIdBytes, passkey.userHandle.count <= 64
          else {
            counts.skippedRelyingParty += 1
            continue
          }
          guard var key = try? PasskeyWebAuthn.importableKey(pkcs8: passkey.key) else {
            counts.skippedAlgorithm += 1
            continue
          }
          let record = PasskeyCredential(
            groupId: groupId, rpId: rpId, credentialId: passkey.credentialID, userHandle: passkey.userHandle,
            userName: String(passkey.userName.prefix(256)), userDisplayName: String(passkey.userDisplayName.prefix(256)),
            created: item.created ?? Date(), source: .apple, backupEligible: true, ready: false)
          switch try? store.add(record, privateX963: key.privateX963) {
          case .added: counts.added += 1
          case .existing: counts.existing += 1
          case .repaired: counts.repaired += 1
          case nil: counts.failed += 1
          }
          key.privateX963.resetBytes(in: 0..<key.privateX963.count)
        }
      }
    }
    return counts
  }
}
