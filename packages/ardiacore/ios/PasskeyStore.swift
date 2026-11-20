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
  var publicKeyLabel: Data? = nil

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

  static func publicKeyLabel(x963: Data) -> Data { Data(SHA256.hash(data: x963)) }
}

extension PasskeyStoreError {
  static func code(_ error: Error) -> String {
    switch error as? PasskeyStoreError {
    case .keychain(let status): return "keychain\(status)"
    case .locked: return "locked"
    case .missingKey: return "missingKey"
    case .cancelled: return "cancelled"
    case .badKey: return "badKey"
    case .keyMismatch: return "keyMismatch"
    case nil: return "other"
    }
  }
}

enum PasskeyKeyPresence: Equatable {
  case present(label: Data?)
  case missing
  case unknown
}

enum PasskeyStoreError: Error, Equatable {
  case keychain(OSStatus)
  case locked
  case missingKey
  case cancelled
  case badKey
  case keyMismatch
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

  private func keyQuery(_ locator: Data, _ keyClass: CFString = kSecAttrKeyClassPrivate) -> [CFString: Any] {
    [kSecClass: kSecClassKey, kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass: keyClass, kSecAttrApplicationTag: locator]
  }

  private func anyKeyQuery(_ locator: Data) -> [CFString: Any] {
    [kSecClass: kSecClassKey, kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrApplicationTag: locator]
  }

  static func silentContext() -> LAContext {
    let context = LAContext()
    context.interactionNotAllowed = true
    return context
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

  private func keyPresence(_ locator: Data) -> PasskeyKeyPresence {
    var query = keyQuery(locator, kSecAttrKeyClassPublic)
    query[kSecReturnData] = true
    query[kSecUseAuthenticationContext] = Self.silentContext()
    var result: CFTypeRef?
    let status = SecItemCopyMatching(base(query), &result)
    switch status {
    case errSecSuccess: return .present(label: (result as? Data).map(PasskeyStoreLocator.publicKeyLabel(x963:)))
    case errSecItemNotFound: return .missing
    default: return .unknown
    }
  }

  private func addPublicKey(locator: Data, publicX963: Data) throws {
    let attributes: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass: kSecAttrKeyClassPublic, kSecAttrKeySizeInBits: 256]
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateWithData(publicX963 as CFData, attributes as CFDictionary, &error) else { throw PasskeyStoreError.badKey }
    var add = keyQuery(locator, kSecAttrKeyClassPublic)
    add[kSecValueRef] = key
    add[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    add[kSecAttrLabel] = "Ardia passkey public key"
    var status = SecItemAdd(base(add), nil)
    if status == errSecDuplicateItem {
      try removeItem(keyQuery(locator, kSecAttrKeyClassPublic))
      status = SecItemAdd(base(add), nil)
    }
    guard status == errSecSuccess else { throw PasskeyStoreError.keychain(status) }
  }

  private func addKey(locator: Data, privateX963: Data) throws {
    let attributes: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass: kSecAttrKeyClassPrivate, kSecAttrKeySizeInBits: 256]
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateWithData(privateX963 as CFData, attributes as CFDictionary, &error) else { throw PasskeyStoreError.badKey }
    var add = keyQuery(locator)
    add[kSecValueRef] = key
    add[kSecAttrAccessControl] = try accessControl()
    add[kSecAttrLabel] = "Ardia passkey"
    var status = SecItemAdd(base(add), nil)
    if status == errSecDuplicateItem {
      try removeItem(keyQuery(locator))
      status = SecItemAdd(base(add), nil)
    }
    guard status == errSecSuccess else { throw PasskeyStoreError.keychain(status) }
  }

  func credentials(groupId: String, rpId: String?) throws -> [PasskeyCredential] {
    try allMetadata().filter { $0.ready && $0.groupId == groupId && (rpId == nil || $0.rpId == rpId) }
  }

  func add(_ credential: PasskeyCredential, privateX963: Data) throws -> PasskeyAddResult {
    let publicX963 = Data(privateX963.prefix(65))
    let label = PasskeyStoreLocator.publicKeyLabel(x963: publicX963)
    return try lock.withLock {
      let locator = credential.locator
      let existing = try allMetadata().first { $0.locator == locator }
      let presence = keyPresence(locator)
      if presence == .unknown { throw PasskeyStoreError.locked }
      if case .present(let found) = presence, found != label { throw PasskeyStoreError.keyMismatch }
      if let existing, existing.ready, existing.publicKeyLabel == label, presence == .present(label: label) { return .existing }
      var pending = credential
      pending.ready = false
      pending.publicKeyLabel = label
      try writeMetadata(pending)
      try addKey(locator: locator, privateX963: privateX963)
      try addPublicKey(locator: locator, publicX963: publicX963)
      pending.ready = true
      try writeMetadata(pending)
      return existing == nil && presence == .missing ? .added : .repaired
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
      try addPublicKey(locator: credential.locator, publicX963: publicX963)
      pending.ready = true
      pending.publicKeyLabel = PasskeyStoreLocator.publicKeyLabel(x963: publicX963)
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
      try removeItem(anyKeyQuery(credential.locator))
      try removeItem(metadataQuery(credential.locator))
    }
  }

  func deleteAll(groupId: String) throws -> Int {
    try lock.withLock {
      let mine = try allMetadata().filter { $0.groupId == groupId }
      for credential in mine {
        try removeItem(anyKeyQuery(credential.locator))
        try removeItem(metadataQuery(credential.locator))
      }
      return mine.count
    }
  }

  func recover() throws {
    try lock.withLock {
      for credential in try allMetadata() {
        switch keyPresence(credential.locator) {
        case .unknown:
          continue
        case .missing:
          try removeItem(anyKeyQuery(credential.locator))
          try removeItem(metadataQuery(credential.locator))
        case .present(let label):
          if let expected = credential.publicKeyLabel, label == expected {
            if !credential.ready {
              var ready = credential
              ready.ready = true
              try writeMetadata(ready)
            }
          } else {
            try removeItem(anyKeyQuery(credential.locator))
            try removeItem(metadataQuery(credential.locator))
          }
        }
      }
      var query = keyQuery(Data(), kSecAttrKeyClassPublic)
      query.removeValue(forKey: kSecAttrApplicationTag)
      query[kSecMatchLimit] = kSecMatchLimitAll
      query[kSecReturnAttributes] = true
      var result: CFTypeRef?
      let status = SecItemCopyMatching(base(query), &result)
      guard status == errSecSuccess, let keys = result as? [[String: Any]] else { return }
      let known = Set(try allMetadata().map(\.locator))
      for attributes in keys {
        guard let tag = attributes[kSecAttrApplicationTag as String] as? Data, tag.count == 32, !known.contains(tag) else { continue }
        try removeItem(anyKeyQuery(tag))
      }
    }
  }
}

final class PasskeyTestStore: PasskeyKeyStore {
  private var entries: [Data: (credential: PasskeyCredential, key: P256.Signing.PrivateKey?)] = [:]
  private let guardLock = NSLock()
  private var signs = 0
  var signCalls: Int { guardLock.withLock { signs } }

  func credentials(groupId: String, rpId: String?) throws -> [PasskeyCredential] {
    guardLock.withLock {
      entries.values.map(\.credential).filter { $0.ready && $0.groupId == groupId && (rpId == nil || $0.rpId == rpId) }
        .sorted { $0.created < $1.created }
    }
  }

  func add(_ credential: PasskeyCredential, privateX963: Data) throws -> PasskeyAddResult {
    guard let key = try? P256.Signing.PrivateKey(x963Representation: privateX963) else { throw PasskeyStoreError.badKey }
    let label = PasskeyStoreLocator.publicKeyLabel(x963: key.publicKey.x963Representation)
    return try guardLock.withLock {
      let locator = credential.locator
      if let existing = entries[locator], let stored = existing.key {
        guard PasskeyStoreLocator.publicKeyLabel(x963: stored.publicKey.x963Representation) == label else { throw PasskeyStoreError.keyMismatch }
        if existing.credential.ready { return .existing }
      }
      let repaired = entries[locator] != nil
      var ready = credential
      ready.ready = true
      ready.publicKeyLabel = label
      entries[locator] = (ready, key)
      return repaired ? .repaired : .added
    }
  }

  func generate(_ credential: PasskeyCredential) throws -> Data {
    let key = P256.Signing.PrivateKey()
    var ready = credential
    ready.ready = true
    ready.publicKeyLabel = PasskeyStoreLocator.publicKeyLabel(x963: key.publicKey.x963Representation)
    guardLock.withLock { entries[credential.locator] = (ready, key) }
    return key.publicKey.x963Representation
  }

  func sign(_ credential: PasskeyCredential, payload: Data, context: LAContext?) throws -> Data {
    let key: P256.Signing.PrivateKey? = guardLock.withLock {
      signs += 1
      return entries[credential.locator]?.key
    }
    guard let key else { throw PasskeyStoreError.missingKey }
    return try key.signature(for: payload).derRepresentation
  }

  func delete(_ credential: PasskeyCredential) throws { _ = guardLock.withLock { entries.removeValue(forKey: credential.locator) } }

  func deleteAll(groupId: String) throws -> Int {
    guardLock.withLock {
      let mine = entries.filter { $0.value.credential.groupId == groupId }
      for key in mine.keys { entries.removeValue(forKey: key) }
      return mine.count
    }
  }

  func recover() throws {}

  func publicKey(_ credential: PasskeyCredential) -> P256.Signing.PublicKey? { guardLock.withLock { entries[credential.locator]?.key?.publicKey } }
}
