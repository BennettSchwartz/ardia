import Foundation

extension PasskeyCoordinator {
  static func configureFromLaunch() {
    let launch = LaunchConfig.shared
    let coordinator = PasskeyCoordinator.shared
    if let data = launch.dataDirectory { lockPath = (data as NSString).appendingPathComponent("passkeys.lock") }
    guard launch.testInstance, launch.testFlag("passkeysTestStore") else { return }
    testStore = PasskeyTestStore()
    coordinator.makeContext = { nil }
    coordinator.verifyOwner = { _, _, done in done(true) }
    coordinator.autoAnswer = launch.testValue("passkeysAnswer")
    coordinator.requiresVisiblePage = false
  }
}
