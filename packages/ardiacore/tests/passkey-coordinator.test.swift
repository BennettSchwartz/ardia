import CryptoKit
import Foundation

var failures = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
  if !condition() {
    failures += 1
    print("FAIL line \(line): \(message)")
  }
}

final class FakePage: NSObject, ArdiaPasskeyPage {
  var passkeyProfile = "Default"
  var passkeyPrivate = false
  var passkeyDocument = 1
  var passkeyTopOrigin: String? = "https://github.com"
  var passkeyVisible = true
  var stillPending = true
  var replies: [[String: Any]] = []
  var emitted: [(String, [String: Any])] = []
  func passkeyConfirm(_ nonce: String, pageId: Int, done: @escaping (Bool) -> Void) { done(stillPending) }
  func passkeyReply(_ nonce: String, pageId: Int, reply: [String: Any]) { replies.append(reply) }
  func passkeyEmit(_ name: String, payload: [String: Any]) { emitted.append((name, payload)) }
}

func spin() { RunLoop.main.run(until: Date().addingTimeInterval(0.2)) }

let suffixes = PasskeyPublicSuffixList(text: try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8))
let store = PasskeyTestStore()
let coordinator = PasskeyCoordinator()
coordinator.makeAuthenticator = { PasskeyAuthenticator(store: store, suffixes: suffixes) }
coordinator.makeContext = { nil }
var ownerVerified = true
coordinator.verifyOwner = { _, _, done in done(ownerVerified) }
var counts: [String] = []
coordinator.record = { counts.append($0) }

let key = P256.Signing.PrivateKey()
let credentialId = Data([1, 2, 3, 4])
_ = try! store.add(PasskeyCredential(groupId: "g1", rpId: "github.com", credentialId: credentialId, userHandle: Data("u".utf8), userName: "octo", userDisplayName: "Octo", created: Date(), source: .apple, backupEligible: true, ready: false), privateX963: key.x963Representation)

let b64 = PasskeyBase64URL.encode
let getJSON = String(data: try! JSONSerialization.data(withJSONObject: ["publicKey": ["challenge": b64(Data(repeating: 1, count: 32))]]), encoding: .utf8)!

let page = FakePage()
coordinator.request("get", options: getJSON, nonce: "n1", pageId: 1, origin: "https://github.com", main: true, page: page)
check(page.replies.last?["fallThrough"] as? Bool == true, "no provider falls through at once")

coordinator.setProviders([PasskeyProviderEntry(profile: "Default", groupId: "g1", create: true)], generation: 1)
check(coordinator.providesForProfile("Default"), "provider set")

page.replies = []
coordinator.request("get", options: getJSON, nonce: "n1", pageId: 2, origin: "https://github.com", main: false, page: page)
check(page.replies.last?["fallThrough"] as? Bool == true, "sub-frame falls through")
coordinator.request("get", options: getJSON, nonce: "n1", pageId: 3, origin: "https://evil.com", main: true, page: page)
check(page.replies.last?["fallThrough"] as? Bool == true, "origin that isn't the committed top origin falls through")
page.passkeyTopOrigin = "https://gitlab.com"
coordinator.request("get", options: getJSON, nonce: "n1", pageId: 4, origin: "https://gitlab.com", main: true, page: page)
check(page.replies.last?["fallThrough"] as? Bool == true, "site without a passkey falls through")
page.passkeyTopOrigin = "https://github.com"

page.replies = []
coordinator.request("get", options: getJSON, nonce: "n1", pageId: 5, origin: "https://github.com", main: true, page: page)
check(page.replies.isEmpty, "a matching request waits for the person")
guard let prompt = page.emitted.last, prompt.0 == "passkeyRequest", let id = prompt.1["id"] as? String else {
  print("FAIL: no prompt emitted")
  exit(1)
}
check(prompt.1["site"] as? String == "github.com" && (prompt.1["accounts"] as? [[String: Any]])?.first?["name"] as? String == "octo", "prompt names the site and account, no keys")
check(prompt.1.keys.allSatisfy { ["id", "kind", "site", "host", "accounts", "userName"].contains($0) }, "prompt carries nothing else")
coordinator.request("get", options: getJSON, nonce: "n1", pageId: 6, origin: "https://github.com", main: true, page: page)
check(page.replies.last?["error"] as? String == "NotAllowedError", "one request per page at a time")
page.replies = []
coordinator.resolve(id, action: "use", account: 0)
spin()
guard let handled = page.replies.last?["handled"] as? [String: Any], let response = handled["response"] as? [String: Any] else {
  print("FAIL: use did not answer \(page.replies)")
  exit(1)
}
let authData = PasskeyBase64URL.decode(response["authenticatorData"] as! String)!
let clientData = PasskeyBase64URL.decode(response["clientDataJSON"] as! String)!
let signature = try! P256.Signing.ECDSASignature(derRepresentation: PasskeyBase64URL.decode(response["signature"] as! String)!)
check(key.publicKey.isValidSignature(signature, for: authData + Data(SHA256.hash(data: clientData))), "answer signed with the stored key")
check(counts.contains("passkey_get_answered"), "answered counted")

RunLoop.main.run(until: Date().addingTimeInterval(PasskeyCoordinator.promptSpacing + 0.1))
page.replies = []
coordinator.request("get", options: getJSON, nonce: "n2", pageId: 7, origin: "https://github.com", main: true, page: page)
let staleId = page.emitted.last!.1["id"] as! String
page.passkeyDocument = 2
coordinator.resolve(staleId, action: "use", account: 0)
spin()
check(page.replies.last?["fallThrough"] as? Bool == true, "a new document drops the request")
check(store.signCalls == 1, "nothing signed for a stale document")
check(coordinator.pendingCount() == 0, "stale request cleared")

page.passkeyDocument = 3
RunLoop.main.run(until: Date().addingTimeInterval(PasskeyCoordinator.promptSpacing + 0.1))
page.stillPending = false
page.replies = []
coordinator.request("get", options: getJSON, nonce: "n3", pageId: 8, origin: "https://github.com", main: true, page: page)
check(page.replies.last?["fallThrough"] as? Bool == true && coordinator.pendingCount() == 0, "no prompt when the page already gave up")
page.stillPending = true

let createJSON = String(data: try! JSONSerialization.data(withJSONObject: ["publicKey": [
  "challenge": b64(Data(repeating: 2, count: 32)), "rp": ["name": "GitHub"], "user": ["id": b64(Data("u2".utf8)), "name": "ann", "displayName": "Ann"],
  "pubKeyCredParams": [["type": "public-key", "alg": -7]],
]]), encoding: .utf8)!
page.replies = []
coordinator.request("create", options: createJSON, nonce: "n4", pageId: 9, origin: "https://github.com", main: true, page: page)
let createId = page.emitted.last!.1["id"] as! String
check(page.emitted.last!.1["kind"] as? String == "create", "create prompt")
ownerVerified = false
coordinator.resolve(createId, action: "save", account: 0)
spin()
check(page.replies.last?["error"] as? String == "NotAllowedError", "save refused without owner verification")
check(try! store.credentials(groupId: "g1", rpId: "github.com").count == 1, "nothing saved")

RunLoop.main.run(until: Date().addingTimeInterval(PasskeyCoordinator.promptSpacing + 0.1))
ownerVerified = true
page.replies = []
coordinator.request("create", options: createJSON, nonce: "n5", pageId: 10, origin: "https://github.com", main: true, page: page)
coordinator.resolve(page.emitted.last!.1["id"] as! String, action: "save", account: 0)
spin()
check(page.replies.last?["handled"] != nil, "save answers with a registration")
check(try! store.credentials(groupId: "g1", rpId: "github.com").count == 2, "new passkey stored")

RunLoop.main.run(until: Date().addingTimeInterval(PasskeyCoordinator.promptSpacing + 0.1))
page.replies = []
coordinator.request("get", options: getJSON, nonce: "n6", pageId: 11, origin: "https://github.com", main: true, page: page)
let abortId = page.emitted.last!.1["id"] as! String
coordinator.cancel("n6", pageId: 11, page: page)
check(coordinator.pendingCount() == 0 && page.replies.isEmpty, "abort clears the request without a second answer")
coordinator.resolve(abortId, action: "use", account: 0)
spin()
check(page.replies.isEmpty, "a late choice after abort does nothing")

RunLoop.main.run(until: Date().addingTimeInterval(PasskeyCoordinator.promptSpacing + 0.1))
coordinator.request("get", options: getJSON, nonce: "n7", pageId: 12, origin: "https://github.com", main: true, page: page)
page.replies = []
coordinator.setProviders([], generation: 2)
check(page.replies.last?["fallThrough"] as? Bool == true, "withdrawing the provider settles open requests")
coordinator.setProviders([PasskeyProviderEntry(profile: "Default", groupId: "g1", create: true)], generation: 1)
check(!coordinator.providesForProfile("Default"), "an older generation is ignored")

if failures > 0 {
  print("\(failures) failure(s)")
  exit(1)
}
print("passkey coordinator: all checks passed")
