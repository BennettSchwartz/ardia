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

  var isOn: Bool {
    didSet {
      guard isOn != oldValue else { return }
      UserDefaults.standard.set(isOn, forKey: Self.onKey)
      if isOn { startDownloadIfNeeded() } else { close() }
    }
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
  private(set) var listening = EarListening()
  private(set) var listeningSessionID: UUID?
  private(set) var isPreparing = false
  private(set) var spokenFraction: Double = 0
  private(set) var sampling: String?

  @ObservationIgnored private var speaker: TalkSpeaker?
  @ObservationIgnored private var loading: Task<TalkSpeaker, Error>?
  @ObservationIgnored private var downloadTask: Task<Void, Never>?
  @ObservationIgnored private var downloadProgress: Progress?
  @ObservationIgnored private let proximity = ProximityFeed()
  @ObservationIgnored private var blocks: [String] = []
  @ObservationIgnored private var answer = ""
  @ObservationIgnored private var startedAtEar = false
  @ObservationIgnored private var countedRead = false
  @ObservationIgnored private var overrideRemoved = false
  @ObservationIgnored private var sessionActive = false
  @ObservationIgnored private var observers: [NSObjectProtocol] = []
  @ObservationIgnored private var transcript: FileHandle?
  @ObservationIgnored private var transcriptStart = ContinuousClock.now

  private init() {
    let defaults = UserDefaults.standard
    isOn = defaults.bool(forKey: Self.onKey)
    let saved = defaults.string(forKey: Self.voiceKey) ?? Self.defaultVoice
    voice = Self.voices.contains { $0.id == saved } ? saved : Self.defaultVoice
    let savedSpeed = defaults.double(forKey: Self.speedKey)
    speed = Self.speeds.contains(savedSpeed) ? savedSpeed : 1
    watchAudio()
    proximity.onChange = { [weak self] near in self?.proximityChanged(near) }
    refresh()
  }

  var isReady: Bool {
    if case .ready = download { return true }
    return false
  }

  var isNear: Bool { listening.isNear }

  func offersListening(_ session: ResearchSession) -> Bool {
    isOn && isReady && session.phase == .done && SpokenAnswer.isReadable(session.answer)
  }

  func isListening(to session: ResearchSession) -> Bool {
    listeningSessionID == session.id
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
      download = .ready(bytes: Self.packDirectory().flatMap(Self.folderSize))
      if isOn, speaker == nil { prepareSpeaker() }
      return
    }
    download = .absent(bytes: nil)
    Task {
      guard let pack = try? await AssetPackManager.shared.manifest.assetPack(withID: Self.assetPackID), case .absent = download else { return }
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
    close()
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
      guard let pack = try await manager.manifest.assetPack(withID: Self.assetPackID) else { throw ManagedBackgroundAssetsError.assetPackNotFound(withID: Self.assetPackID) }
      try await manager.ensureLocalAvailability(of: pack)
      try Task.checkCancellation()
      downloadTask = nil
      downloadProgress = nil
      download = .ready(bytes: Self.packDirectory().flatMap(Self.folderSize))
      BrowseForMeHost.shared.countTalkToMe("voice_downloads")
      if isOn { prepareSpeaker() }
    } catch {
      guard !Task.isCancelled, downloadTask != nil else { return }
      downloadTask = nil
      downloadProgress = nil
      if (error as NSError).domain == NSCocoaErrorDomain, (error as NSError).code == NSUserCancelledError {
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

  func watch(_ session: ResearchSession) {
    guard isOn, isReady else { return }
    if listeningSessionID != session.id {
      close()
      listeningSessionID = session.id
      listening = EarListening()
      startedAtEar = false
      countedRead = false
      spokenFraction = 0
      prepareSpeaker()
      proximity.start()
    }
    answerChanged(session)
  }

  func answerChanged(_ session: ResearchSession) {
    guard listeningSessionID == session.id else { return }
    if session.answer != answer, !answer.isEmpty {
      speaker?.stop()
      listening.reset()
      startedAtEar = false
      countedRead = false
      spokenFraction = 0
      blocks = []
      answer = ""
    }
    guard session.phase == .done else { return }
    guard offersListening(session) else { return close(session) }
    guard session.answer != answer else { return }
    answer = session.answer
    blocks = SpokenAnswer.blocks(session.answer)
    perform(listening.answerReady())
  }

  func toggleSpeaker(_ session: ResearchSession) {
    guard listeningSessionID == session.id else { return }
    perform(listening.toggleSpeaker())
  }

  func close(_ session: ResearchSession) {
    guard listeningSessionID == session.id else { return }
    close()
  }

  func close() {
    proximity.stop()
    listeningSessionID = nil
    listening = EarListening()
    blocks = []
    answer = ""
    spokenFraction = 0
    isPreparing = false
    stop()
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
        guard route(.speaker) else { return sampling = nil }
        speaker.play([String(localized: "Hi, I’m \(name). I’ll read your Browse for Me answers aloud.")])
      } catch {
        sampling = nil
        BrowseForMeHost.shared.countTalkToMe("failed")
      }
    }
  }

  func stop() {
    sampling = nil
    speaker?.stop()
    speaker?.finishRecording()
    if listening.isPlaying { listening.routeFailed() }
    deactivateAudio()
  }

  private func proximityChanged(_ near: Bool) {
    perform(listening.proximity(isNear: near))
  }

  private func perform(_ command: EarListening.Command) {
    switch command {
    case .none:
      return
    case .start(let output):
      startedAtEar = output == .earpiece
      speak(from: 0)
    case .resume(let output):
      guard let speaker, speaker.isSpeaking else { return speak(from: 0) }
      guard route(output) else { return listening.routeFailed() }
      speaker.resume()
    case .reroute(let output):
      guard route(output) else {
        speaker?.pause()
        return listening.routeFailed()
      }
    case .pause:
      speaker?.pause()
    }
  }

  private func speak(from index: Int) {
    let id = listeningSessionID
    let texts = blocks
    isPreparing = speaker == nil
    Task {
      do {
        let speaker = try await loadSpeaker()
        isPreparing = false
        guard listeningSessionID == id, listening.isPlaying, let current = listening.output else { return }
        guard route(current) else { return listening.routeFailed() }
        speaker.play(texts, from: index)
      } catch {
        isPreparing = false
        guard listeningSessionID == id else { return }
        BrowseForMeHost.shared.countTalkToMe("failed")
        listening.routeFailed()
      }
    }
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
    made.onFinished = { [weak self] in self?.finishedSpeaking() }
    made.onProgress = { [weak self] fraction in self?.progressed(fraction) }
    made.onFirstAudio = { [weak self] waited in self?.firstAudio(after: waited) }
    made.onFailure = { [weak self] message in self?.failed(message) }
    guard PhoneTestBuild.isOn, let path = UserDefaults.standard.string(forKey: Self.recordKey), !path.isEmpty else { return }
    let url = URL(fileURLWithPath: path)
    try? made.record(to: url)
    let transcriptURL = url.appendingPathExtension("txt")
    FileManager.default.createFile(atPath: transcriptURL.path, contents: nil)
    transcript = try? FileHandle(forWritingTo: transcriptURL)
    transcriptStart = .now
    made.onUtterance = { [weak self] index, text in self?.note(index, text) }
  }

  private func note(_ index: Int, _ text: String) {
    let elapsed = (ContinuousClock.now - transcriptStart).components
    let seconds = Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
    let output = sampling != nil ? "sample" : listening.output == .earpiece ? "earpiece" : "speaker"
    let line = String(format: "%.2f\t%@\t%d\t%@\n", seconds, output, index, text.replacingOccurrences(of: "\n", with: " "))
    NSLog("TALKTOME utterance: %@", line)
    transcript?.write(Data(line.utf8))
  }

  private func finishedSpeaking() {
    if sampling != nil {
      sampling = nil
      deactivateAudio()
      return
    }
    guard listeningSessionID != nil else { return }
    listening.finished()
    spokenFraction = 1
    speaker?.finishRecording()
    deactivateAudio()
  }

  private func progressed(_ fraction: Double) {
    guard sampling == nil, listeningSessionID != nil else { return }
    spokenFraction = fraction
  }

  private func firstAudio(after waited: Duration) {
    NSLog("TALKTOME first audio after %@ (%@)", "\(waited)", sampling != nil ? "sample" : listening.output == .earpiece ? "earpiece" : "speaker")
    guard listeningSessionID != nil, sampling == nil, !countedRead else { return }
    countedRead = true
    BrowseForMeHost.shared.countTalkToMe("answers_read")
    if startedAtEar { BrowseForMeHost.shared.countTalkToMe("ear_listens") }
  }

  private func failed(_ message: String) {
    NSLog("TALKTOME failed: %@", message)
    BrowseForMeHost.shared.countTalkToMe("failed")
    stop()
  }

  private func route(_ output: ListeningOutput) -> Bool {
    let audio = AVAudioSession.sharedInstance()
    do {
      switch output {
      case .earpiece:
        try audio.setCategory(.playAndRecord, mode: .spokenAudio, options: [.allowBluetoothHFP])
        try audio.overrideOutputAudioPort(.none)
      case .speaker:
        try audio.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
      }
      try audio.setActive(true)
      sessionActive = true
      return true
    } catch {
      NSLog("TALKTOME audio route %@: %@", output == .earpiece ? "earpiece" : "speaker", error.localizedDescription)
      return false
    }
  }

  private func deactivateAudio() {
    guard sessionActive else { return }
    sessionActive = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func watchAudio() {
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: AVAudioSession.didBecomeInactiveNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.interrupted() }
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
    if sampling != nil { return stop() }
    guard listening.isPlaying else { return }
    speaker?.pause()
    listening.routeFailed()
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
