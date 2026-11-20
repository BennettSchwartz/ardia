import Foundation

extension PasskeyCoordinator {
  static func configureFromLaunch() {
    if let data = ArdiaHost.dataDirectory { lockPath = (data as NSString).appendingPathComponent("passkeys.lock") }
    #if DEBUG
      let launch = LaunchConfig.shared
      if launch.testInstance, launch.testFlag("passkeysTestStore") {
        let coordinator = PasskeyCoordinator.shared
        testStore = PasskeyTestStore()
        coordinator.makeContext = { nil }
        coordinator.verifyOwner = { _, _, done in done(true) }
        coordinator.autoAnswer = launch.testValue("passkeysAnswer")
        coordinator.requiresVisiblePage = false
        return
      }
    #endif
    DispatchQueue.global(qos: .utility).async { try? PasskeyCoordinator.defaultStore().recover() }
  }
}
