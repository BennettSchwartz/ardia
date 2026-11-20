import AuthenticationServices

@objc(ArdiaPasskeysProviderViewController)
final class ArdiaPasskeysProviderViewController: ASCredentialProviderViewController {
  private func decline() {
    extensionContext.cancelRequest(withError: NSError(domain: ASExtensionErrorDomain, code: ASExtensionError.Code.userCanceled.rawValue))
  }

  override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) { decline() }
  override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier], requestParameters: ASPasskeyCredentialRequestParameters) { decline() }
  override func provideCredentialWithoutUserInteraction(for credentialRequest: any ASCredentialRequest) { decline() }
  override func prepareInterfaceToProvideCredential(for credentialRequest: any ASCredentialRequest) { decline() }
  override func prepareInterface(forPasskeyRegistration registrationRequest: any ASCredentialRequest) { decline() }
  override func prepareInterfaceForExtensionConfiguration() { decline() }
}
