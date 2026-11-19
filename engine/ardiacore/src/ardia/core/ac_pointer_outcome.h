// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_CORE_AC_POINTER_OUTCOME_H_
#define ARDIA_CORE_AC_POINTER_OUTCOME_H_

#include <cstddef>
#include <cstdint>
#include <vector>

namespace ardia {

class PageEpoch {
 public:
  uint64_t value() const { return value_; }
  void Committed() { ++value_; }
  bool Unchanged(uint64_t admitted) const {
    return admitted != 0 && admitted == value_;
  }

 private:
  uint64_t value_ = 1;
};

enum class PointerEventResult { kPending, kNotSent, kSentUnknown, kAcked };

enum class PointerOutcome { kPending, kDone, kNotDelivered, kUnknown };

struct PointerEvent {
  bool press = false;
  PointerEventResult result = PointerEventResult::kPending;
};

inline bool PointerEventSent(const PointerEvent& event) {
  return event.result == PointerEventResult::kSentUnknown ||
         event.result == PointerEventResult::kAcked;
}

inline PointerOutcome PointerOutcomeOf(const std::vector<PointerEvent>& events,
                                       bool epoch_unchanged,
                                       bool widget_alive) {
  if (events.empty()) {
    return PointerOutcome::kNotDelivered;
  }
  bool all_acked = true;
  bool press_sent = false;
  bool has_press = false;
  for (const PointerEvent& event : events) {
    if (event.result == PointerEventResult::kPending) {
      return PointerOutcome::kPending;
    }
    all_acked = all_acked && event.result == PointerEventResult::kAcked;
    has_press = has_press || event.press;
    press_sent = press_sent || (event.press && PointerEventSent(event));
  }
  if (has_press ? !press_sent : !PointerEventSent(events.front())) {
    return PointerOutcome::kNotDelivered;
  }
  return all_acked && epoch_unchanged && widget_alive ? PointerOutcome::kDone
                                                      : PointerOutcome::kUnknown;
}

inline bool RefusesHiddenTarget(bool wheel, bool hidden) {
  return wheel && hidden;
}

inline bool NeedsRecoveryRelease(const std::vector<PointerEvent>& events,
                                 PointerOutcome outcome) {
  if (outcome != PointerOutcome::kUnknown) {
    return false;
  }
  for (const PointerEvent& event : events) {
    if (event.press && PointerEventSent(event)) {
      return true;
    }
  }
  return false;
}

}

#endif
