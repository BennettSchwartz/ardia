import AppleArchive
import ArdiaBrowser
import ArdiaTalk
import AVFoundation
import CryptoKit
import Foundation
import Observation
import System
import UIKit

@MainActor
@Observable
final class TalkToMe {
  static let shared = TalkToMe()

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
  @ObservationIgnored private var downloadID: UUID?
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
    if case .failed = download { return }
    if let installed = VoiceDownload.installed() {
      download = .ready(bytes: Self.folderSize(installed))
      if isOn, speaker == nil { prepareSpeaker() }
      return
    }
    VoiceDownload.removeOutdated()
    download = .absent(bytes: VoiceDownload.bytes)
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
    let id = UUID()
    downloadID = id
    download = .downloading(0)
    downloadTask = Task { await runDownload(id) }
  }

  func cancelDownload() {
    downloadTask?.cancel()
    downloadTask = nil
    downloadID = nil
    isOn = false
    download = .absent(bytes: VoiceDownload.bytes)
    refresh()
  }

  func removeDownload() {
    close()
    loading?.cancel()
    loading = nil
    speaker = nil
    downloadTask?.cancel()
    downloadTask = nil
    downloadID = nil
    isOn = false
    if overrideDirectory() != nil {
      overrideRemoved = true
      download = .absent(bytes: VoiceDownload.bytes)
      return
    }
    VoiceDownload.remove()
    download = .absent(bytes: VoiceDownload.bytes)
  }

  private func runDownload(_ id: UUID) async {
    let started = ContinuousClock.now
    do {
      try await VoiceDownload.fetch { [weak self] fraction in
        Task { @MainActor in self?.downloaded(fraction, of: id) }
      }
      try Task.checkCancellation()
      guard downloadID == id else { return }
      guard let installed = VoiceDownload.installed() else { throw VoiceDownload.Problem.noModels }
      NSLog("TALKTOME voice installed after %@", "\(ContinuousClock.now - started)")
      downloadTask = nil
      downloadID = nil
      download = .ready(bytes: Self.folderSize(installed))
      BrowseForMeHost.shared.countTalkToMe("voice_downloads")
      if isOn { prepareSpeaker() }
    } catch {
      guard !Task.isCancelled, downloadID == id else { return }
      downloadTask = nil
      downloadID = nil
      NSLog("TALKTOME download failed: %@", String(describing: error))
      BrowseForMeHost.shared.countTalkToMe("download_failed")
      download = .failed(Self.downloadProblem(error))
    }
  }

  private func downloaded(_ fraction: Double, of id: UUID) {
    guard downloadID == id, case .downloading = download else { return }
    download = .downloading(fraction)
  }

  static func downloadProblem(_ error: Error) -> String {
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
        try await speaker.setVoice(voice)
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
    observers.append(center.addObserver(forName: AVAudioSession.didBecomeInactiveNotification, object: nil, queue: .main) { [weak self] note in
      let context = note.userInfo?[AVAudioSession.deactivationContextKey] as? AVAudioSession.DeactivationContext
      let bySystem = context?.source != .app
      MainActor.assumeIsolated { if bySystem { self?.interrupted() } }
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
    guard !overrideRemoved else { return nil }
    return Self.testBuildModels()
  }

  static func testBuildModels() -> URL? {
    guard PhoneTestBuild.isOn, let path = UserDefaults.standard.string(forKey: modelsOverrideKey), !path.isEmpty else { return nil }
    let url = URL(fileURLWithPath: path, isDirectory: true)
    return FileManager.default.fileExists(atPath: url.appending(path: "bundle.json").path) ? url : nil
  }

  private func modelsDirectory() -> URL? {
    overrideDirectory() ?? VoiceDownload.installed()
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

enum VoiceDownload {
  static let url = URL(string: "https://github.com/ardia-browser/ardia-voices/releases/download/phonon-31m-en-v0.7.1/phonon-31m-en.aar")!
  static let bytes = 132_936_282
  static let sha256 = "f72408f24f92dd92682819709aaca0d525d5f2fcea26243be90063e9d9df6579"

  enum Problem: Error {
    case status(Int)
    case wrongSize(Int)
    case wrongHash
    case unreadable
    case noModels
  }

  static let folderName = "TalkToMe"
  static let markerName = "voice.sha256"
  static let incomingPrefix = "TalkToMe-incoming-"

  static var support: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
  }

  static var folder: URL {
    support.appending(path: folderName, directoryHint: .isDirectory)
  }

  static func installed() -> URL? {
    let folder = folder
    guard FileManager.default.fileExists(atPath: folder.appending(path: "bundle.json").path),
          let marker = try? String(contentsOf: folder.appending(path: markerName), encoding: .utf8),
          marker.trimmingCharacters(in: .whitespacesAndNewlines) == sha256 else { return nil }
    return folder
  }

  static func removeOutdated() {
    guard installed() == nil, FileManager.default.fileExists(atPath: folder.path) else { return }
    try? FileManager.default.removeItem(at: folder)
  }

  static func remove() {
    try? FileManager.default.removeItem(at: folder)
    removeIncoming()
  }

  static func removeIncoming() {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: support.path)) ?? []
    for name in names where name.hasPrefix(incomingPrefix) {
      try? FileManager.default.removeItem(at: support.appending(path: name, directoryHint: .isDirectory))
    }
  }

  static func fetch(progress: @escaping @Sendable (Double) -> Void) async throws {
    let incoming = support.appending(path: incomingPrefix + UUID().uuidString, directoryHint: .isDirectory)
    removeIncoming()
    try FileManager.default.createDirectory(at: incoming, withIntermediateDirectories: true)
    try excludeFromBackup(incoming)
    defer { try? FileManager.default.removeItem(at: incoming) }
    let archive = incoming.appending(path: url.lastPathComponent)
    try await VoiceTransfer(destination: archive, progress: progress).run(url)
    let work = Task.detached(priority: .userInitiated) { try install(archive, in: incoming) }
    try await withTaskCancellationHandler { try await work.value } onCancel: { work.cancel() }
  }

  static func install(_ archive: URL, in incoming: URL) throws {
    do {
      try verify(archive)
    } catch {
      try? FileManager.default.removeItem(at: archive)
      throw error
    }
    try Task.checkCancellation()
    let unpacked = incoming.appending(path: "unpacked", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: unpacked, withIntermediateDirectories: true)
    try extract(archive, to: unpacked)
    try? FileManager.default.removeItem(at: archive)
    let staged = unpacked.appending(path: folderName, directoryHint: .isDirectory)
    guard FileManager.default.fileExists(atPath: staged.appending(path: "bundle.json").path) else { throw Problem.noModels }
    try Data(sha256.utf8).write(to: staged.appending(path: markerName))
    try Task.checkCancellation()
    if FileManager.default.fileExists(atPath: folder.path) {
      _ = try FileManager.default.replaceItemAt(folder, withItemAt: staged)
    } else {
      try FileManager.default.moveItem(at: staged, to: folder)
    }
    try excludeFromBackup(folder)
  }

  static func verify(_ archive: URL) throws {
    let size = (try? archive.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? -1
    guard size == bytes else { throw Problem.wrongSize(size) }
    let handle = try FileHandle(forReadingFrom: archive)
    defer { try? handle.close() }
    var hash = SHA256()
    while let chunk = try handle.read(upToCount: 4 << 20), !chunk.isEmpty {
      try Task.checkCancellation()
      hash.update(data: chunk)
    }
    let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
    guard digest == sha256 else { throw Problem.wrongHash }
  }

  static func extract(_ archive: URL, to destination: URL) throws {
    guard let file = ArchiveByteStream.fileStream(path: FilePath(archive.path), mode: .readOnly, options: [], permissions: FilePermissions(rawValue: 0o644)) else { throw Problem.unreadable }
    defer { try? file.close() }
    guard let decompressed = ArchiveByteStream.decompressionStream(readingFrom: file) else { throw Problem.unreadable }
    defer { try? decompressed.close() }
    guard let decoded = ArchiveStream.decodeStream(readingFrom: decompressed) else { throw Problem.unreadable }
    defer { try? decoded.close() }
    guard let extracted = ArchiveStream.extractStream(extractingTo: FilePath(destination.path), flags: [.ignoreOperationNotPermitted]) else { throw Problem.unreadable }
    _ = try ArchiveStream.process(readingFrom: decoded, writingTo: extracted)
    try extracted.close()
  }

  static func excludeFromBackup(_ url: URL) throws {
    var url = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  }
}

final class VoiceTransfer: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  private let destination: URL
  private let progress: @Sendable (Double) -> Void
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Void, Error>?
  private var moved: Result<Void, Error>?
  private var reported = -1.0

  init(destination: URL, progress: @escaping @Sendable (Double) -> Void) {
    self.destination = destination
    self.progress = progress
  }

  func run(_ url: URL) async throws {
    let configuration = URLSessionConfiguration.default
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    let task = session.downloadTask(with: url)
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        lock.withLock { self.continuation = continuation }
        task.resume()
        if Task.isCancelled { task.cancel() }
      }
    } onCancel: {
      task.cancel()
    }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
    let total = totalBytesExpectedToWrite > 0 ? Double(totalBytesExpectedToWrite) : Double(VoiceDownload.bytes)
    let fraction = min(1, Double(totalBytesWritten) / total)
    let report = lock.withLock {
      guard fraction - reported >= 0.005 || fraction == 1 else { return false }
      reported = fraction
      return true
    }
    if report { progress(fraction) }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    let result = Result<Void, Error> {
      if let status = (downloadTask.response as? HTTPURLResponse)?.statusCode, !(200..<300).contains(status) { throw VoiceDownload.Problem.status(status) }
      try? FileManager.default.removeItem(at: destination)
      try FileManager.default.moveItem(at: location, to: destination)
    }
    lock.withLock { moved = result }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    session.finishTasksAndInvalidate()
    let (continuation, moved) = lock.withLock {
      defer { self.continuation = nil }
      return (self.continuation, self.moved)
    }
    if let error {
      continuation?.resume(throwing: error)
    } else {
      continuation?.resume(with: moved ?? .failure(VoiceDownload.Problem.unreadable))
    }
  }
}
