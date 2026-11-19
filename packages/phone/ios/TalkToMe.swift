import ArdiaBrowser
import ArdiaTalk
import AVFoundation
import BackgroundAssets
import Foundation
import Observation
import System
import UIKit

@MainActor
@Observable
final class TalkToMe {
  static let shared = TalkToMe()

  static let assetPackID = "talk-to-me-phonon-31m-en"
  static let modelsManifest: FilePath = "TalkToMe/bundle.json"
  static let onKey = "ArdiaTalkToMeOn"
  static let automaticKey = "ArdiaTalkToMeAutomatically"
  static let voiceKey = "ArdiaTalkToMeVoice"
  static let speedKey = "ArdiaTalkToMeSpeed"
  static let modelsOverrideKey = "ArdiaTalkToMeModels"
  static let recordKey = "ArdiaTalkToMeRecord"

  struct Voice: Identifiable, Equatable {
    var id: String
    var accent: String
  }

  static let voices = [
    Voice(id: "Harper", accent: String(localized: "American")),
    Voice(id: "Juniper", accent: String(localized: "American")),
    Voice(id: "Miles", accent: String(localized: "American")),
    Voice(id: "Preston", accent: String(localized: "American")),
    Voice(id: "Maeve", accent: String(localized: "British")),
    Voice(id: "Hugh", accent: String(localized: "British")),
  ]
  static let defaultVoice = "Harper"
  static let speeds: [Double] = [0.8, 0.9, 1, 1.1, 1.25, 1.5]

  enum Download: Equatable {
    case checking
    case absent(bytes: Int?)
    case downloading(Double)
    case ready(bytes: Int?)
    case failed(String)
  }

  enum Reading: Equatable {
    case idle
    case preparing
    case speaking
  }

  var isOn: Bool {
    didSet {
      guard isOn != oldValue else { return }
      UserDefaults.standard.set(isOn, forKey: Self.onKey)
      if isOn { startDownloadIfNeeded() } else { stop() }
    }
  }

  var readsAutomatically: Bool {
    didSet { UserDefaults.standard.set(readsAutomatically, forKey: Self.automaticKey) }
  }

  var voice: String {
    didSet {
      UserDefaults.standard.set(voice, forKey: Self.voiceKey)
      let chosen = voice
      Task { try? await speaker?.setVoice(chosen) }
    }
  }

  var speed: Double {
    didSet {
      UserDefaults.standard.set(speed, forKey: Self.speedKey)
      speaker?.rate = Float(speed)
    }
  }

  private(set) var download: Download = .checking
  private(set) var reading: Reading = .idle
  private(set) var readingSessionID: UUID?
  private(set) var sampling: String?

  @ObservationIgnored private var speaker: TalkSpeaker?
  @ObservationIgnored private var loading: Task<TalkSpeaker, Error>?
  @ObservationIgnored private var downloadTask: Task<Void, Never>?
  @ObservationIgnored private var downloadProgress: Progress?
  @ObservationIgnored private var feed = SpokenAnswerFeed()
  @ObservationIgnored private weak var readingSession: ResearchSession?
  @ObservationIgnored private var declined: Set<UUID> = []
  @ObservationIgnored private var countedRead = false
  @ObservationIgnored private var overrideRemoved = false
  @ObservationIgnored private var sessionActive = false
  @ObservationIgnored private var observers: [NSObjectProtocol] = []
  @ObservationIgnored private var transcript: FileHandle?
  @ObservationIgnored private var transcriptStart = ContinuousClock.now

  private init() {
    let defaults = UserDefaults.standard
    isOn = defaults.bool(forKey: Self.onKey)
    readsAutomatically = defaults.object(forKey: Self.automaticKey) as? Bool ?? false
    let saved = defaults.string(forKey: Self.voiceKey) ?? Self.defaultVoice
    voice = Self.voices.contains { $0.id == saved } ? saved : Self.defaultVoice
    let savedSpeed = defaults.double(forKey: Self.speedKey)
    speed = Self.speeds.contains(savedSpeed) ? savedSpeed : 1
    watchAudio()
    refresh()
  }

  var isReady: Bool {
    if case .ready = download { return true }
    return false
  }

  func canRead(_ session: ResearchSession) -> Bool {
    guard isOn, isReady, !session.answer.isEmpty else { return false }
    if case .other = SpokenAnswer.language(of: SpokenAnswer.text(session.answer)) { return false }
    return true
  }

  func isReading(_ session: ResearchSession) -> Bool {
    readingSessionID == session.id && reading != .idle
  }

  func refresh() {
    guard downloadTask == nil else { return }
    if let override = overrideDirectory() {
      download = .ready(bytes: Self.folderSize(override))
      return
    }
    guard Self.offersAssetPack else {
      download = .absent(bytes: nil)
      return
    }
    if AssetPackManager.shared.assetPackIsAvailableLocally(withID: Self.assetPackID) {
      download = .ready(bytes: Self.packDirectory().map(Self.folderSize))
      if isOn, speaker == nil { prepareSpeaker() }
      return
    }
    download = .absent(bytes: nil)
    Task {
      guard let pack = try? await AssetPackManager.shared.assetPack(withID: Self.assetPackID), case .absent = download else { return }
      download = .absent(bytes: pack.downloadSize)
    }
    if isOn { startDownloadIfNeeded() }
  }

  func startDownloadIfNeeded() {
    switch download {
    case .absent, .failed: startDownload()
    case .ready: prepareSpeaker()
    case .checking, .downloading: break
    }
  }

  func startDownload() {
    guard downloadTask == nil, overrideDirectory() == nil else { return }
    download = .downloading(0)
    downloadTask = Task { await runDownload() }
  }

  func cancelDownload() {
    downloadProgress?.cancel()
    downloadTask?.cancel()
    downloadTask = nil
    downloadProgress = nil
    isOn = false
    download = .absent(bytes: nil)
    refresh()
  }

  func removeDownload() {
    stop()
    loading?.cancel()
    loading = nil
    speaker = nil
    isOn = false
    if overrideDirectory() != nil {
      overrideRemoved = true
      download = .absent(bytes: nil)
      return
    }
    Task {
      try? await AssetPackManager.shared.remove(assetPackWithID: Self.assetPackID)
      download = .absent(bytes: nil)
      refresh()
    }
  }

  private func runDownload() async {
    let manager = AssetPackManager.shared
    let updates = Task { [weak self] in
      for await update in manager.statusUpdates(forAssetPackWithID: Self.assetPackID) {
        guard let self else { return }
        if case .downloading(_, let progress) = update {
          self.downloadProgress = progress
          if case .downloading = self.download { self.download = .downloading(progress.fractionCompleted) }
        }
      }
    }
    defer { updates.cancel() }
    do {
      let pack = try await manager.assetPack(withID: Self.assetPackID)
      try await manager.ensureLocalAvailability(of: pack)
      try Task.checkCancellation()
      downloadTask = nil
      downloadProgress = nil
      download = .ready(bytes: Self.packDirectory().map(Self.folderSize))
      BrowseForMeHost.shared.countTalkToMe("voice_downloads")
      if isOn { prepareSpeaker() }
    } catch {
      guard !Task.isCancelled, downloadTask != nil else { return }
      downloadTask = nil
      downloadProgress = nil
      if (error as NSError).code == NSUserCancelledError {
        download = .absent(bytes: nil)
        return
      }
      BrowseForMeHost.shared.countTalkToMe("download_failed")
      download = .failed(Self.downloadProblem(error))
    }
  }

  static func downloadProblem(_ error: Error) -> String {
    if let managed = error as? ManagedBackgroundAssetsError, case .assetPackNotFound = managed {
      return String(localized: "The voice downloads in App Store and TestFlight builds only.")
    }
    if (error as? URLError) != nil || (error as NSError).domain == NSURLErrorDomain {
      return String(localized: "Couldn’t download the voice. Check your connection and try again.")
    }
    return String(localized: "Couldn’t download the voice. Try again in a moment.")
  }

  func follow(_ session: ResearchSession) {
    if readingSessionID == session.id {
      pump()
      return
    }
    guard readsAutomatically, readingSessionID == nil, !declined.contains(session.id), canRead(session) else { return }
    start(session)
  }

  func toggle(_ session: ResearchSession) {
    if isReading(session) {
      declined.insert(session.id)
      stop()
    } else {
      declined.remove(session.id)
      start(session)
    }
  }

  func sample(_ name: String) {
    guard isReady else { return }
    stop()
    voice = name
    sampling = name
    Task {
      do {
        let speaker = try await loadSpeaker()
        guard sampling == name else { return }
        try await speaker.setVoice(name)
        guard sampling == name else { return }
        activateAudio()
        speaker.speak(String(localized: "Hi, I’m \(name). I’ll read your Browse for Me answers aloud."))
      } catch {
        sampling = nil
        BrowseForMeHost.shared.countTalkToMe("failed")
      }
    }
  }

  func stop() {
    readingSessionID = nil
    readingSession = nil
    sampling = nil
    reading = .idle
    feed = SpokenAnswerFeed()
    speaker?.stop()
    deactivateAudio()
  }

  func stop(_ session: ResearchSession) {
    guard readingSessionID == session.id else { return }
    stop()
  }

  private func start(_ session: ResearchSession) {
    stop()
    readingSessionID = session.id
    readingSession = session
    reading = .preparing
    countedRead = false
    let id = session.id
    Task {
      do {
        _ = try await loadSpeaker()
        guard readingSessionID == id else { return }
        activateAudio()
        pump()
      } catch {
        guard readingSessionID == id else { return }
        BrowseForMeHost.shared.countTalkToMe("failed")
        stop()
      }
    }
  }

  private func pump() {
    guard let session = readingSession, let speaker, readingSessionID == session.id else { return }
    let finished = session.phase == .done
    if case .failed = session.phase { return stop() }
    if let step = feed.advance(answer: session.answer, finished: finished) {
      if step.restarted { speaker.stop() }
      if !step.text.isEmpty { speaker.speak(step.text) }
    }
    if case .other = feed.language { return stop() }
    if finished, !speaker.isSpeaking { stop() }
  }

  private func prepareSpeaker() {
    guard speaker == nil, loading == nil else { return }
    Task { _ = try? await loadSpeaker() }
  }

  private func loadSpeaker() async throws -> TalkSpeaker {
    if let speaker { return speaker }
    if let loading { return try await loading.value }
    guard let directory = modelsDirectory() else { throw CancellationError() }
    let chosen = voice
    let task = Task { try await TalkSpeaker.load(models: directory, voice: chosen) }
    loading = task
    do {
      let made = try await task.value
      loading = nil
      configure(made)
      speaker = made
      return made
    } catch {
      loading = nil
      throw error
    }
  }

  private func configure(_ made: TalkSpeaker) {
    made.rate = Float(speed)
    made.onSpeakingChange = { [weak self] speaking in self?.speakingChanged(speaking) }
    made.onFirstAudio = { [weak self] waited in self?.firstAudio(after: waited) }
    made.onFailure = { [weak self] message in self?.failed(message) }
    guard PhoneTestBuild.isOn, let path = UserDefaults.standard.string(forKey: Self.recordKey), !path.isEmpty else { return }
    let url = URL(fileURLWithPath: path)
    try? made.record(to: url)
    let transcriptURL = url.appendingPathExtension("txt")
    FileManager.default.createFile(atPath: transcriptURL.path, contents: nil)
    transcript = try? FileHandle(forWritingTo: transcriptURL)
    transcriptStart = .now
    made.onUtterance = { [weak self] text in self?.note(text) }
  }

  private func note(_ text: String) {
    let elapsed = (ContinuousClock.now - transcriptStart).components
    let seconds = Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
    let line = String(format: "%.2f\t%@\n", seconds, text.replacingOccurrences(of: "\n", with: " "))
    NSLog("TALKTOME utterance: %@", line)
    transcript?.write(Data(line.utf8))
  }

  private func speakingChanged(_ speaking: Bool) {
    if speaking { return }
    if sampling != nil {
      sampling = nil
      deactivateAudio()
      return
    }
    guard let session = readingSession, readingSessionID == session.id else { return }
    if session.phase == .done { stop() }
  }

  private func firstAudio(after waited: Duration) {
    NSLog("TALKTOME first audio after %@", "\(waited)")
    guard readingSessionID != nil, sampling == nil else { return }
    reading = .speaking
    guard !countedRead else { return }
    countedRead = true
    BrowseForMeHost.shared.countTalkToMe("answers_read")
  }

  private func failed(_ message: String) {
    NSLog("TALKTOME failed: %@", message)
    BrowseForMeHost.shared.countTalkToMe("failed")
    stop()
  }

  private func activateAudio() {
    let audio = AVAudioSession.sharedInstance()
    do {
      try audio.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
      try audio.setActive(true)
      sessionActive = true
    } catch {
      NSLog("TALKTOME audio session: %@", error.localizedDescription)
    }
  }

  private func deactivateAudio() {
    guard sessionActive else { return }
    sessionActive = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func watchAudio() {
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init) == .began
      MainActor.assumeIsolated { if began { self?.interrupted() } }
    })
    observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
      let lost = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init) == .oldDeviceUnavailable
      MainActor.assumeIsolated { if lost { self?.interrupted() } }
    })
    observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.servicesReset() }
    })
    observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.interrupted() }
    })
  }

  private func interrupted() {
    guard readingSessionID != nil || sampling != nil else { return }
    if let id = readingSessionID { declined.insert(id) }
    stop()
  }

  private func servicesReset() {
    stop()
    speaker = nil
  }

  private func overrideDirectory() -> URL? {
    guard PhoneTestBuild.isOn, !overrideRemoved, let path = UserDefaults.standard.string(forKey: Self.modelsOverrideKey), !path.isEmpty else { return nil }
    let url = URL(fileURLWithPath: path, isDirectory: true)
    return FileManager.default.fileExists(atPath: url.appending(path: "bundle.json").path) ? url : nil
  }

  private func modelsDirectory() -> URL? {
    overrideDirectory() ?? Self.packDirectory()
  }

  static var offersAssetPack: Bool {
    Bundle.main.object(forInfoDictionaryKey: "BAHasManagedAssetPacks") as? Bool == true
  }

  static func packDirectory() -> URL? {
    guard offersAssetPack, AssetPackManager.shared.assetPackIsAvailableLocally(withID: assetPackID) else { return nil }
    return try? AssetPackManager.shared.url(for: modelsManifest).deletingLastPathComponent()
  }

  static func folderSize(_ url: URL) -> Int? {
    guard let files = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .isRegularFileKey]) else { return nil }
    var total = 0
    for case let file as URL in files {
      let values = try? file.resourceValues(forKeys: [.totalFileAllocatedSizeKey, .isRegularFileKey])
      if values?.isRegularFile == true { total += values?.totalFileAllocatedSize ?? 0 }
    }
    return total
  }

  static func size(_ bytes: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
  }
}
