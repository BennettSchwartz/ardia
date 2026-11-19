// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_CORE_AC_POINTER_OUTCOME_H_
#define ARDIA_CORE_AC_POINTER_OUTCOME_H_

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

enum class PointerEventResult { kPending, kDelivered, kDropped };

enum class PointerOutcome { kPending, kDone, kNotDelivered, kUnknown };

inline PointerOutcome PointerOutcomeOf(
    const std::vector<PointerEventResult>& events,
    bool epoch_unchanged,
    bool widget_alive) {
  if (events.empty()) {
    return PointerOutcome::kNotDelivered;
  }
  for (PointerEventResult event : events) {
    if (event == PointerEventResult::kPending) {
      return PointerOutcome::kPending;
    }
  }
  if (events.front() != PointerEventResult::kDelivered) {
    return PointerOutcome::kNotDelivered;
  }
  for (PointerEventResult event : events) {
    if (event != PointerEventResult::kDelivered) {
      return PointerOutcome::kUnknown;
    }
  }
  return epoch_unchanged && widget_alive ? PointerOutcome::kDone
                                         : PointerOutcome::kUnknown;
}

inline bool NeedsRecoveryRelease(bool click, PointerOutcome outcome) {
  return click && outcome == PointerOutcome::kUnknown;
}

}

#endif
