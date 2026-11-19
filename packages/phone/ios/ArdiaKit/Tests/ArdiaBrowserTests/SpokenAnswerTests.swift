import Foundation
import Testing
@testable import ArdiaBrowser

struct SpokenAnswerTests {
  @Test func cleaningDropsCitationsLinksAndMarkdown() {
    let answer = """
      ## The **Golden Gate** Bridge
      It opened in 1937 [1][2] and spans 1,280 m [3, 4].
      - Designed by *Joseph Strauss* [2]
      1. Painted `International Orange` [5]
      See [the history](https://example.com/history) for more.
      Key facts:
      """
    #expect(SpokenAnswer.text(answer) == """
      The Golden Gate Bridge.
      It opened in 1937 and spans 1,280 m.
      Designed by Joseph Strauss.
      Painted International Orange.
      See the history for more.
      Key facts.
      """)
  }

  @Test func readyHoldsBackThePartialLastSentence() {
    #expect(SpokenAnswer.ready("Everest is tall [1]. It was first climb", finished: false) == "Everest is tall.")
    #expect(SpokenAnswer.ready("Everest is tall [1]. It was first climbed in 1953.", finished: false) == "Everest is tall.")
    #expect(SpokenAnswer.ready("Everest is tall [1]. It was first climbed in 1953. ", finished: false) == "Everest is tall. It was first climbed in 1953.")
    #expect(SpokenAnswer.ready("Everest is tall [1]. It was first climbed in 1953.", finished: true) == "Everest is tall. It was first climbed in 1953.")
    #expect(SpokenAnswer.ready("A partial line with no end", finished: true) == "A partial line with no end.")
  }

  @Test func abbreviationsAndDecimalsDoNotEndASentence() {
    #expect(SpokenAnswer.ready("Dr. Smith paid 3.5 million vs. the plan, e.g. a lot. Then", finished: false) == "Dr. Smith paid 3.5 million vs. the plan, e.g. a lot.")
    #expect(SpokenAnswer.ready("It was built by J. Strauss in the U.S. over four years. Next", finished: false) == "It was built by J. Strauss in the U.S. over four years.")
  }

  @Test func aGrowingAnswerIsSpokenOnceInOrderWithNothingDropped() {
    let full = "## History\nThe bridge opened in 1937 [1]. It was the longest suspension bridge [2]. Fog is common!\n- Its color is International Orange [3].\n- It carries about 112,000 vehicles a day [4]."
    var feed = SpokenAnswerFeed()
    var heard: [String] = []
    var index = full.startIndex
    while index < full.endIndex {
      index = full.index(index, offsetBy: min(7, full.distance(from: index, to: full.endIndex)))
      if let step = feed.advance(answer: String(full[..<index]), finished: false) {
        #expect(!step.restarted)
        heard.append(step.text)
      }
    }
    if let step = feed.advance(answer: full, finished: true) { heard.append(step.text) }
    #expect(heard.joined(separator: " ").replacingOccurrences(of: "\n", with: " ") == SpokenAnswer.text(full).replacingOccurrences(of: "\n", with: " "))
    #expect(heard.first?.hasPrefix("History.\n") == true)
    #expect(heard.allSatisfy { !$0.isEmpty })
    #expect(feed.advance(answer: full, finished: true) == nil)
  }

  @Test func aRewrittenAnswerRestartsFromItsBeginning() {
    var feed = SpokenAnswerFeed()
    let first = "ChatGPT started to write this answer about the bridge. And then"
    #expect(feed.advance(answer: first, finished: false)?.text == "ChatGPT started to write this answer about the bridge.")
    #expect(feed.advance(answer: "", finished: false) == SpokenAnswerFeed.Step(text: "", restarted: true))
    let second = "Apple Intelligence wrote this one about the bridge instead. More"
    #expect(feed.advance(answer: second, finished: false) == SpokenAnswerFeed.Step(text: "Apple Intelligence wrote this one about the bridge instead.", restarted: false))
  }

  @Test func languageGateWaitsForEnoughTextThenDecides() {
    #expect(SpokenAnswer.language(of: "Short.") == .undecided)
    #expect(SpokenAnswer.language(of: "The Golden Gate Bridge opened in 1937 and is painted orange.") == .english)
    #expect(SpokenAnswer.language(of: "Le pont du Golden Gate a été inauguré en 1937 et il est peint en orange.") == .other("fr"))
    var feed = SpokenAnswerFeed()
    #expect(feed.advance(answer: "Der Eiffelturm wurde 1889 für die Weltausstellung in Paris gebaut. Er ist", finished: false) == nil)
    #expect(feed.language == .other("de"))
    #expect(feed.advance(answer: "Der Eiffelturm wurde 1889 für die Weltausstellung in Paris gebaut. Er ist hoch.", finished: true) == nil)
  }

  @Test func aShortFinishedAnswerIsStillRead() {
    var feed = SpokenAnswerFeed()
    #expect(feed.advance(answer: "Yes [1].", finished: false) == nil)
    #expect(feed.advance(answer: "Yes [1].", finished: true)?.text == "Yes.")
  }
}
