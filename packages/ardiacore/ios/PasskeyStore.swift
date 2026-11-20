import CryptoKit
import Foundation
import LocalAuthentication
import Security

enum PasskeySource: String, Codable {
  case apple
  case ardia
}

struct PasskeyCredential: Codable, Equatable {
  let groupId: String
  let rpId: String
  let credentialId: Data
  let userHandle: Data
  let userName: String
  let userDisplayName: String
  let created: Date
  let source: PasskeySource
  let backupEligible: Bool
  var ready: Bool

  var locator: Data { PasskeyStoreLocator.of(groupId: groupId, rpId: rpId, credentialId: credentialId) }
}

enum PasskeyStoreLocator {
  static func of(groupId: String, rpId: String, credentialId: Data) -> Data {
    var input = Data(groupId.utf8)
    input.append(0)
    input.append(Data(rpId.utf8))
    input.append(0)
    input.append(credentialId)
    return Data(SHA256.hash(data: input))
  }

  static func hex(_ locator: Data) -> String { locator.map { String(format: "%02x", $0) }.joined() }
}

enum PasskeyStoreError: Error, Equatable {
  case keychain(OSStatus)
  case locked
  case missingKey
  case cancelled
  case badKey
}

enum PasskeyAddResult: Equatable {
  case added
  case existing
  case repaired
}

protocol PasskeyKeyStore: AnyObject {
  func credentials(groupId: String, rpId: String?) throws -> [PasskeyCredential]
  func add(_ credential: PasskeyCredential, privateX963: Data) throws -> PasskeyAddResult
  func generate(_ credential: PasskeyCredential) throws -> Data
  func sign(_ credential: PasskeyCredential, payload: Data, context: LAContext?) throws -> Data
  func delete(_ credential: PasskeyCredential) throws
  func deleteAll(groupId: String) throws -> Int
  func recover() throws
}

final class PasskeyStoreLock {
  private let path: String

  init(path: String) { self.path = path }

  func withLock<T>(_ body: () throws -> T) throws -> T {
    let fd = open(path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw PasskeyStoreError.locked }
    defer { close(fd) }
    guard flock(fd, LOCK_EX) == 0 else { throw PasskeyStoreError.locked }
    defer { flock(fd, LOCK_UN) }
    return try body()
  }
}

final class PasskeyKeychainStore: PasskeyKeyStore {
  static let service = "com.ardia.browser.passkeys"
  private let accessGroup: String
  private let lock: PasskeyStoreLock

  init(accessGroup: String, lockPath: String) {
    self.accessGroup = accessGroup
    self.lock = PasskeyStoreLock(path: lockPath)
  }

  private func base(_ query: [CFString: Any]) -> CFDictionary {
    var all = query
    all[kSecUseDataProtectionKeychain] = true
    all[kSecAttrAccessGroup] = accessGroup
    all[kSecAttrSynchronizable] = false
    return all as CFDictionary
  }

  private func metadataQuery(_ locator: Data) -> [CFString: Any] {
    [kSecClass: kSecClassGenericPassword, kSecAttrService: Self.service, kSecAttrAccount: PasskeyStoreLocator.hex(locator)]
  }

  private func keyQuery(_ locator: Data) -> [CFString: Any] {
    [kSecClass: kSecClassKey, kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass: kSecAttrKeyClassPrivate,
     kSecAttrApplicationTag: locator]
  }

  private func accessControl() throws -> SecAccessControl {
    var error: Unmanaged<CFError>?
    guard let control = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .userPresence, &error) else {
      throw PasskeyStoreError.badKey
    }
    return control
  }

  private func writeMetadata(_ credential: PasskeyCredential) throws {
    let data = try JSONEncoder().encode(credential)
    let query = metadataQuery(credential.locator)
    let update = SecItemUpdate(base(query), [kSecValueData: data] as CFDictionary)
    if update == errSecSuccess { return }
    guard update == errSecItemNotFound else { throw PasskeyStoreError.keychain(update) }
    var add = query
    add[kSecValueData] = data
    add[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    add[kSecAttrLabel] = "Ardia passkey details"
    let status = SecItemAdd(base(add), nil)
    guard status == errSecSuccess else { throw PasskeyStoreError.keychain(status) }
  }

  private func allMetadata() throws -> [PasskeyCredential] {
    var query = metadataQuery(Data())
    query.removeValue(forKey: kSecAttrAccount)
    query[kSecMatchLimit] = kSecMatchLimitAll
    query[kSecReturnData] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(base(query), &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let items = result as? [Data] else { throw PasskeyStoreError.keychain(status) }
    return items.compactMap { try? JSONDecoder().decode(PasskeyCredential.self, from: $0) }
  }

  private func keyExists(_ locator: Data) -> Bool {
    var query = keyQuery(locator)
    query[kSecUseAuthenticationUI] = kSecUseAuthenticationUISkip
    let status = SecItemCopyMatching(base(query), nil)
    return status == errSecSuccess || status == errSecInteractionNotAllowed
  }

  private func addKey(locator: Data, privateX963: Data) throws {
    let attributes: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass: kSecAttrKeyClassPrivate, kSecAttrKeySizeInBits: 256]
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateWithData(privateX963 as CFData, attributes as CFDictionary, &error) else { throw PasskeyStoreError.badKey }
    var add = keyQuery(locator)
    add[kSecValueRef] = key
    add[kSecAttrAccessControl] = try accessControl()
    add[kSecAttrLabel] = "Ardia passkey"
    let status = SecItemAdd(base(add), nil)
    guard status == errSecSuccess || status == errSecDuplicateItem else { throw PasskeyStoreError.keychain(status) }
  }

  func credentials(groupId: String, rpId: String?) throws -> [PasskeyCredential] {
    try allMetadata().filter { $0.ready && $0.groupId == groupId && (rpId == nil || $0.rpId == rpId) }
  }

  func add(_ credential: PasskeyCredential, privateX963: Data) throws -> PasskeyAddResult {
    try lock.withLock {
      let locator = credential.locator
      let existing = try allMetadata().first { $0.locator == locator }
      let hasKey = keyExists(locator)
      if let existing, existing.ready, hasKey { return .existing }
      var pending = credential
      pending.ready = false
      try writeMetadata(pending)
      if !hasKey { try addKey(locator: locator, privateX963: privateX963) }
      pending.ready = true
      try writeMetadata(pending)
      return existing == nil && !hasKey ? .added : .repaired
    }
  }

  func generate(_ credential: PasskeyCredential) throws -> Data {
    try lock.withLock {
      var pending = credential
      pending.ready = false
      try writeMetadata(pending)
      var privateAttributes = keyQuery(credential.locator)
      privateAttributes.removeValue(forKey: kSecClass)
      privateAttributes.removeValue(forKey: kSecAttrKeyType)
      privateAttributes.removeValue(forKey: kSecAttrKeyClass)
      privateAttributes[kSecAttrIsPermanent] = true
      privateAttributes[kSecAttrAccessControl] = try accessControl()
      privateAttributes[kSecAttrLabel] = "Ardia passkey"
      privateAttributes[kSecUseDataProtectionKeychain] = true
      privateAttributes[kSecAttrAccessGroup] = accessGroup
      let attributes: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits: 256, kSecPrivateKeyAttrs: privateAttributes]
      var error: Unmanaged<CFError>?
      guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error), let publicKey = SecKeyCopyPublicKey(key),
        let publicX963 = SecKeyCopyExternalRepresentation(publicKey, &error) as Data?
      else { throw PasskeyStoreError.badKey }
      pending.ready = true
      try writeMetadata(pending)
      return publicX963
    }
  }

  func sign(_ credential: PasskeyCredential, payload: Data, context: LAContext?) throws -> Data {
    var query = keyQuery(credential.locator)
    query[kSecReturnRef] = true
    if let context { query[kSecUseAuthenticationContext] = context }
    var result: CFTypeRef?
    let status = SecItemCopyMatching(base(query), &result)
    if status == errSecUserCanceled { throw PasskeyStoreError.cancelled }
    guard status == errSecSuccess, let found = result, CFGetTypeID(found) == SecKeyGetTypeID() else {
      throw status == errSecItemNotFound ? PasskeyStoreError.missingKey : PasskeyStoreError.keychain(status)
    }
    let key = found as! SecKey
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, payload as CFData, &error) as Data? else {
      let code = (error?.takeRetainedValue()).map { CFErrorGetCode($0) } ?? 0
      if code == Int(errSecUserCanceled) || code == LAError.userCancel.rawValue { throw PasskeyStoreError.cancelled }
      throw PasskeyStoreError.keychain(OSStatus(code))
    }
    return signature
  }

  private func removeItem(_ query: [CFString: Any]) throws {
    let status = SecItemDelete(base(query))
    guard status == errSecSuccess || status == errSecItemNotFound else { throw PasskeyStoreError.keychain(status) }
  }

  func delete(_ credential: PasskeyCredential) throws {
    try lock.withLock {
      try removeItem(keyQuery(credential.locator))
      try removeItem(metadataQuery(credential.locator))
    }
  }

  func deleteAll(groupId: String) throws -> Int {
    try lock.withLock {
      let mine = try allMetadata().filter { $0.groupId == groupId }
      for credential in mine {
        try removeItem(keyQuery(credential.locator))
        try removeItem(metadataQuery(credential.locator))
      }
      return mine.count
    }
  }

  func recover() throws {
    try lock.withLock {
      for credential in try allMetadata() where !credential.ready || !keyExists(credential.locator) {
        if keyExists(credential.locator) {
          var ready = credential
          ready.ready = true
          try writeMetadata(ready)
        } else {
          try removeItem(metadataQuery(credential.locator))
        }
      }
      var query = keyQuery(Data())
      query.removeValue(forKey: kSecAttrApplicationTag)
      query[kSecMatchLimit] = kSecMatchLimitAll
      query[kSecReturnAttributes] = true
      query[kSecUseAuthenticationUI] = kSecUseAuthenticationUISkip
      var result: CFTypeRef?
      let status = SecItemCopyMatching(base(query), &result)
      guard status == errSecSuccess, let keys = result as? [[CFString: Any]] else { return }
      let known = Set(try allMetadata().map(\.locator))
      for attributes in keys {
        guard let tag = attributes[kSecAttrApplicationTag] as? Data, tag.count == 32, !known.contains(tag) else { continue }
        try removeItem(keyQuery(tag))
      }
    }
  }
}

final class PasskeyTestStore: PasskeyKeyStore {
  private var entries: [Data: (credential: PasskeyCredential, key: P256.Signing.PrivateKey?)] = [:]
  var signCalls = 0

  func credentials(groupId: String, rpId: String?) throws -> [PasskeyCredential] {
    entries.values.map(\.credential).filter { $0.ready && $0.groupId == groupId && (rpId == nil || $0.rpId == rpId) }
      .sorted { $0.created < $1.created }
  }

  func add(_ credential: PasskeyCredential, privateX963: Data) throws -> PasskeyAddResult {
    let locator = credential.locator
    if let existing = entries[locator], existing.credential.ready, existing.key != nil { return .existing }
    guard let key = try? P256.Signing.PrivateKey(x963Representation: privateX963) else { throw PasskeyStoreError.badKey }
    let repaired = entries[locator] != nil
    var ready = credential
    ready.ready = true
    entries[locator] = (ready, key)
    return repaired ? .repaired : .added
  }

  func generate(_ credential: PasskeyCredential) throws -> Data {
    let key = P256.Signing.PrivateKey()
    var ready = credential
    ready.ready = true
    entries[credential.locator] = (ready, key)
    return key.publicKey.x963Representation
  }

  func sign(_ credential: PasskeyCredential, payload: Data, context: LAContext?) throws -> Data {
    signCalls += 1
    guard let key = entries[credential.locator]?.key else { throw PasskeyStoreError.missingKey }
    return try key.signature(for: payload).derRepresentation
  }

  func delete(_ credential: PasskeyCredential) throws { entries.removeValue(forKey: credential.locator) }

  func deleteAll(groupId: String) throws -> Int {
    let mine = entries.filter { $0.value.credential.groupId == groupId }
    for key in mine.keys { entries.removeValue(forKey: key) }
    return mine.count
  }

  func recover() throws {}

  func publicKey(_ credential: PasskeyCredential) -> P256.Signing.PublicKey? { entries[credential.locator]?.key?.publicKey }
}
