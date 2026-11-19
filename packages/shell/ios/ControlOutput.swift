import Darwin
import Foundation

struct ControlOutput {
  static let maxEventBytes = 4 * 1024 * 1024
  static let maxReplyBytes = 34 * 1024 * 1024
  static let maxWaitingEvents = 1000

  enum WriteResult { case drained, blocked, failed }

  private struct Chunk {
    var data: Data
    let event: Bool
    var ticket = 0
  }

  private var chunks: [Chunk] = []
  private var headStarted = false
  private var offset = 0
  private(set) var bytes = 0
  private(set) var eventBytes = 0
  private(set) var waitingEvents = 0
  private(set) var dropped = 0
  private var finished: [Int] = []

  var isEmpty: Bool { chunks.isEmpty }

  mutating func addReply(_ data: Data, ticket: Int) -> Bool {
    guard bytes - eventBytes + data.count <= Self.maxReplyBytes else { return false }
    bytes += data.count
    chunks.append(Chunk(data: data, event: false, ticket: ticket))
    return true
  }

  mutating func takeFinishedTickets() -> [Int] {
    defer { finished = [] }
    return finished
  }

  var waitingTickets: [Int] { chunks.map(\.ticket).filter { $0 > 0 } }

  mutating func addEvent(_ data: Data) -> Bool {
    while waitingEvents >= Self.maxWaitingEvents || eventBytes + data.count > Self.maxEventBytes {
      guard let index = oldestWaitingEvent() else {
        dropped += 1
        return true
      }
      bytes -= chunks[index].data.count
      eventBytes -= chunks[index].data.count
      chunks.remove(at: index)
      waitingEvents -= 1
      dropped += 1
    }
    waitingEvents += 1
    bytes += data.count
    eventBytes += data.count
    chunks.append(Chunk(data: data, event: true))
    return true
  }

  mutating func write(to fd: Int32) -> WriteResult {
    while !chunks.isEmpty {
      guard startHead() else { return .failed }
      let data = chunks[0].data
      let written = data.withUnsafeBytes { raw -> Int in
        guard let base = raw.baseAddress else { return 0 }
        return Darwin.write(fd, base + offset, data.count - offset)
      }
      if written < 0 {
        if errno == EINTR { continue }
        return errno == EAGAIN || errno == EWOULDBLOCK ? .blocked : .failed
      }
      offset += written
      bytes -= written
      if chunks[0].event { eventBytes -= written }
      if offset == data.count {
        if chunks[0].ticket > 0 { finished.append(chunks[0].ticket) }
        chunks.removeFirst()
        offset = 0
        headStarted = false
      }
    }
    return .drained
  }

  private func oldestWaitingEvent() -> Int? {
    chunks.indices.first { chunks[$0].event && !($0 == 0 && headStarted) }
  }

  private mutating func startHead() -> Bool {
    guard !headStarted else { return true }
    headStarted = true
    guard chunks[0].event else { return true }
    waitingEvents -= 1
    guard dropped > 0 else { return true }
    let marked = Self.marking(chunks[0].data, dropped: dropped)
    let grown = marked.count - chunks[0].data.count
    bytes += grown
    eventBytes += grown
    chunks[0].data = marked
    dropped = 0
    return true
  }

  static func marking(_ line: Data, dropped: Int) -> Data {
    guard line.count >= 2, line.first == UInt8(ascii: "{"), line[line.startIndex + 1] != UInt8(ascii: "}") else { return line }
    var marked = Data("{\"dropped\":\(dropped),".utf8)
    marked.append(line.dropFirst())
    return marked
  }
}
