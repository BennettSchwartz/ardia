import AppKit
import WebKit

private var passkeyStateKey: UInt8 = 0

final class WebKitPasskeyState {
  var document = 0
  var topOrigin: String?
  var replies: [String: (Any?, String?) -> Void] = [:]
}

extension WebKitTab: ArdiaPasskeyPage {
  var passkeyState: WebKitPasskeyState {
    if let state = objc_getAssociatedObject(self, &passkeyStateKey) as? WebKitPasskeyState { return state }
    let state = WebKitPasskeyState()
    objc_setAssociatedObject(self, &passkeyStateKey, state, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    return state
  }

  var passkeyProfile: String { profile }
  var passkeyPrivate: Bool { WebKitStores.isPrivate(profile) }
  var passkeyDocument: Int { passkeyState.document }
  var passkeyTopOrigin: String? { passkeyState.topOrigin }
  var passkeyVisible: Bool { visible && window?.isKeyWindow == true && window?.isVisible == true && !isHiddenOrHasHiddenAncestor }

  func passkeyConfirm(_ nonce: String, pageId: Int, done: @escaping (Bool) -> Void) {
    done(passkeyState.replies[Self.passkeyKey(nonce, pageId)] != nil)
  }

  func passkeyReply(_ nonce: String, pageId: Int, reply: [String: Any]) {
    guard let answer = passkeyState.replies.removeValue(forKey: Self.passkeyKey(nonce, pageId)) else { return }
    answer(reply, nil)
  }

  func passkeyEmit(_ name: String, payload: [String: Any]) { emit(name, payload) }

  static func passkeyKey(_ nonce: String, _ pageId: Int) -> String { "\(nonce):\(pageId)" }

  func passkeyCommitted(_ webView: WKWebView) {
    let state = passkeyState
    state.document += 1
    state.topOrigin = webView.url.flatMap { url -> String? in
      guard let scheme = url.scheme, let host = url.host(percentEncoded: true) else { return nil }
      return "\(scheme)://\(host)" + (url.port.map { ":\($0)" } ?? "")
    }
    for (_, answer) in state.replies { answer(["fallThrough": true], nil) }
    state.replies.removeAll()
    PasskeyCoordinator.shared.pageChanged(self)
  }

  func passkeyMessage(_ body: [String: Any], frameInfo: WKFrameInfo, answer: @escaping (Any?, String?) -> Void) {
    guard let kind = body["kind"] as? String, let nonce = body["nonce"] as? String, nonce.count <= 64,
      let pageId = (body["id"] as? NSNumber)?.intValue, pageId > 0
    else { return answer(["fallThrough": true], nil) }
    let origin = frameInfo.securityOrigin
    let serialized = origin.host.isEmpty ? nil : "\(origin.protocol)://\(origin.host)" + (origin.port > 0 ? ":\(origin.port)" : "")
    if kind == "cancel" {
      passkeyState.replies.removeValue(forKey: Self.passkeyKey(nonce, pageId))
      PasskeyCoordinator.shared.cancel(nonce, pageId: pageId, page: self)
      return answer(["aborted": true], nil)
    }
    let key = Self.passkeyKey(nonce, pageId)
    guard passkeyState.replies[key] == nil else { return answer(["fallThrough": true], nil) }
    passkeyState.replies[key] = answer
    PasskeyCoordinator.shared.request(
      kind, options: body["options"] as? String ?? "{}", nonce: nonce, pageId: pageId, origin: serialized, main: frameInfo.isMainFrame, page: self)
  }
}
