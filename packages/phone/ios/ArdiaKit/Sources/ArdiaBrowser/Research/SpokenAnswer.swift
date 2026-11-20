import Foundation
import NaturalLanguage

public enum SpokenAnswer {
  public enum Language: Equatable, Sendable {
    case undecided
    case english
    case other(String)
  }

  public static let decidingLetters = 40

  public static func text(_ answer: String) -> String {
    ready(answer, finished: true)
  }

  public static func blocks(_ answer: String) -> [String] {
    text(answer).split(whereSeparator: \.isNewline).map(String.init)
  }

  public static func isReadable(_ answer: String) -> Bool {
    let spoken = text(answer)
    guard !spoken.isEmpty else { return false }
    if case .other = language(of: spoken) { return false }
    return true
  }

  public static func ready(_ answer: String, finished: Bool) -> String {
    var lines = answer.components(separatedBy: .newlines)
    let open = finished ? nil : lines.popLast()
    var parts = lines.compactMap(block).map(closed)
    if let open, let line = block(open) {
      let done = finishedSentences(open.last?.isWhitespace == true ? line + " " : line)
      if !done.isEmpty { parts.append(done) }
    }
    return parts.joined(separator: "\n")
  }

  public static func language(of text: String) -> Language {
    guard text.unicodeScalars.filter(CharacterSet.letters.contains).count >= decidingLetters else { return .undecided }
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)
    guard let dominant = recognizer.dominantLanguage else { return .undecided }
    return dominant == .english ? .english : .other(dominant.rawValue)
  }

  static func block(_ rawLine: String) -> String? {
    let line = rawLine.trimmingCharacters(in: .whitespaces)
    guard !line.isEmpty else { return nil }
    guard let parsed = ResearchAnswer.blocks(withoutListNumber(line)).first else { return nil }
    let text = inline(parsed.text)
    return text.isEmpty ? nil : text
  }

  static func withoutListNumber(_ line: String) -> String {
    guard let match = line.prefixMatch(of: listNumberPattern) else { return line }
    return String(line[match.range.upperBound...])
  }

  static func inline(_ text: String) -> String {
    var cleaned = ResearchAnswer.withoutCitations(text)
    cleaned = cleaned.replacing(linkPattern) { String($0.output.1) }
    cleaned = cleaned.replacingOccurrences(of: "*", with: "").replacingOccurrences(of: "`", with: "").replacingOccurrences(of: "__", with: "")
    cleaned = cleaned.replacing(spacesPattern, with: " ")
    return cleaned.trimmingCharacters(in: .whitespaces)
  }

  static func closed(_ text: String) -> String {
    guard let last = text.last else { return text }
    return ".!?:;…".contains(last) || closers.contains(last) ? text : text + "."
  }

  static func finishedSentences(_ text: String) -> String {
    var end: String.Index?
    var index = text.startIndex
    while index < text.endIndex {
      let character = text[index]
      if ".!?…".contains(character) {
        var after = text.index(after: index)
        while after < text.endIndex, closers.contains(text[after]) { after = text.index(after: after) }
        if after < text.endIndex, text[after].isWhitespace, !endsInAbbreviation(text[..<index]) {
          end = text.index(before: after)
        }
        index = after
      } else {
        index = text.index(after: index)
      }
    }
    guard let end else { return "" }
    return String(text[...end]).trimmingCharacters(in: .whitespaces)
  }

  static func endsInAbbreviation(_ head: Substring) -> Bool {
    let word = head.split(whereSeparator: { $0.isWhitespace || $0 == "(" }).last.map(String.init) ?? ""
    if word.count == 1, word.first?.isLetter == true { return true }
    if word.contains("."), word.count <= 4 { return true }
    return abbreviations.contains(word.lowercased())
  }

  static let closers: Set<Character> = ["\"", "'", "”", "’", ")", "]"]
  static let abbreviations: Set<String> = ["mr", "mrs", "ms", "dr", "st", "vs", "etc", "e.g", "i.e", "approx", "no", "jr", "sr", "inc", "ltd", "co", "mt", "ft", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"]
  nonisolated(unsafe) static let listNumberPattern = /\d{1,3}[.)]\s+/
  nonisolated(unsafe) static let linkPattern = /\[([^\]\[]+)\]\([^)\s]*\)/
  nonisolated(unsafe) static let spacesPattern = /[ \t]{2,}/
}
