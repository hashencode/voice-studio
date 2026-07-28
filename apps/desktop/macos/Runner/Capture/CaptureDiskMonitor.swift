import Foundation

final class CaptureDiskMonitor {
  private let queue = DispatchQueue(
    label: "com.voice2text.desktop.capture.disk",
    qos: .utility
  )
  private var timer: DispatchSourceTimer?
  private var fired = false

  func start(
    root: URL,
    minimumFreeBytes: Int64,
    onLowDisk: @escaping (Int64) -> Void
  ) {
    stop()
    fired = false
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler { [weak self] in
      guard let self, !self.fired else { return }
      let available = (
        try? root.resourceValues(
          forKeys: [.volumeAvailableCapacityForImportantUsageKey]
        ).volumeAvailableCapacityForImportantUsage
      ) ?? 0
      guard available < minimumFreeBytes else { return }
      self.fired = true
      onLowDisk(available)
    }
    self.timer = timer
    timer.resume()
  }

  func stop() {
    timer?.setEventHandler {}
    timer?.cancel()
    timer = nil
  }

  deinit {
    stop()
  }
}
