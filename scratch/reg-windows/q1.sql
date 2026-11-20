SELECT app_version, uniq(distinct_id) AS people,
  sum(toUInt64OrZero(properties['little_ardia_link_windows_kept_at_activation'])) AS kept_at_activation,
  sum(toUInt64OrZero(properties['little_ardia_link_holds_without_link'])) AS holds_without_link,
  sum(toUInt64OrZero(properties['little_ardia_link_holds_left_to_stage_manager'])) AS left_to_sm,
  sum(toUInt64OrZero(properties['little_ardia_link_windows_kept_on_arrival'])) AS on_arrival,
  sum(toUInt64OrZero(properties['little_ardia_link_windows_kept_on_open'])) AS on_open
FROM telemetry.events WHERE event = 'usage_counts' AND timestamp >= now() - INTERVAL 10 DAY AND app_version LIKE '0.2.47-nightly%'
GROUP BY app_version ORDER BY app_version
