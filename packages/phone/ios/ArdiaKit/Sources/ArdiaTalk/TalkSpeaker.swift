import AVFoundation
import Foundation
import PhononTTS

@MainActor
public final class TalkSpeaker {
  public static let sampleRate = Phonon.sampleRate

  public private(set) var isSpeaking = false
  public private(set) var voice: String
  public var voices: [String] { tts.voices }
  public var onSpeakingChange: ((Bool) -> Void)?
  public var onFirstAudio: ((Duration) -> Void)?
  public var onFailure: ((String) -> Void)?
  public var onUtterance: ((String) -> Void)?

  private let tts: Phonon
  private let engine = AVAudioEngine()
  private let node = AVAudioPlayerNode()
  private let timePitch = AVAudioUnitTimePitch()
  private let format: AVAudioFormat
  private var queue: [String] = []
  private var worker: Task<Void, Never>?
  private var scheduled = 0
  private var generation = 0
  private var askedAt: ContinuousClock.Instant?
  private var recording: AVAudioFile?
  private var configurationObserver: NSObjectProtocol?

  public static func load(models: URL, voice: String?) async throws -> TalkSpeaker {
    let tts = try await Phonon.load(models: models, language: .english)
    let speaker = try TalkSpeaker(tts: tts)
    if let voice, voice != tts.voice, tts.voices.contains(voice) { try await speaker.setVoice(voice) }
    return speaker
  }

  private init(tts: Phonon) throws {
    self.tts = tts
    voice = tts.voice
    guard let format = AVAudioFormat(standardFormatWithSampleRate: Phonon.sampleRate, channels: 1) else {
      throw PhononError(description: "No audio format for Phonon's samples")
    }
    self.format = format
    engine.attach(node)
    engine.attach(timePitch)
    try engine.connectNode(node, to: timePitch, format: format)
    try engine.connectNode(timePitch, to: engine.mainMixerNode, format: format)
    configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.stop() }
    }
  }

  isolated deinit {
    if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
    worker?.cancel()
    node.stop()
    engine.stop()
  }

  public var rate: Float {
    get { timePitch.rate }
    set { timePitch.rate = min(max(newValue, 0.5), 2) }
  }

  public func setVoice(_ name: String) async throws {
    guard name != voice else { return }
    try await tts.setVoice(name)
    voice = name
  }

  public func record(to url: URL) throws {
    try? FileManager.default.removeItem(at: url)
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: Phonon.sampleRate,
      AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
    ]
    recording = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
  }

  public func speak(_ text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    queue.append(trimmed)
    if askedAt == nil, !isSpeaking { askedAt = .now }
    setSpeaking(true)
    guard worker == nil else { return }
    let current = generation
    worker = Task { [weak self] in await self?.drain(generation: current) }
  }

  public func stop() {
    generation += 1
    worker?.cancel()
    worker = nil
    queue.removeAll()
    scheduled = 0
    askedAt = nil
    node.stop()
    if let recording, recording.length > 0 {
      recording.close()
      self.recording = nil
    }
    setSpeaking(false)
  }

  private func drain(generation current: Int) async {
    while current == generation, !queue.isEmpty {
      let text = queue.removeFirst()
      onUtterance?(text)
      do {
        try startEngine()
        for try await chunk in tts.stream(text) {
          guard current == generation, !Task.isCancelled else { break }
          schedule(chunk, generation: current)
        }
      } catch {
        guard current == generation, !Task.isCancelled else { return }
        let message = (error as? PhononError)?.description ?? error.localizedDescription
        stop()
        onFailure?(message)
        return
      }
    }
    guard current == generation else { return }
    worker = nil
    settleIfDone()
  }

  private func startEngine() throws {
    if !engine.isRunning {
      engine.prepare()
      try engine.start()
    }
    if !node.isPlaying { try node.playAudio() }
  }

  private func schedule(_ samples: [Float], generation current: Int) {
    guard !samples.isEmpty, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)), let channel = buffer.floatChannelData?[0] else { return }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { source in
      if let base = source.baseAddress { channel.update(from: base, count: samples.count) }
    }
    if let recording { try? recording.write(from: buffer) }
    if let askedAt {
      onFirstAudio?(ContinuousClock.now - askedAt)
      self.askedAt = nil
    }
    scheduled += 1
    node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      Task { @MainActor [weak self] in self?.played(generation: current) }
    }
  }

  private func played(generation current: Int) {
    guard current == generation else { return }
    scheduled = max(scheduled - 1, 0)
    settleIfDone()
  }

  private func settleIfDone() {
    guard scheduled == 0, queue.isEmpty, worker == nil else { return }
    setSpeaking(false)
  }

  private func setSpeaking(_ speaking: Bool) {
    guard speaking != isSpeaking else { return }
    isSpeaking = speaking
    onSpeakingChange?(speaking)
  }
}
