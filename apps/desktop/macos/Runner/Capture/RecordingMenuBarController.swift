import AppKit

/// Mirrors capture controls without owning capture state.
///
/// Mutating actions return to Flutter, where the shared controller applies
/// its state guard and idempotency key.
final class RecordingMenuBarController: NSObject {
  var onAction: ((String) -> Void)?

  private var statusItem: NSStatusItem?
  private var captureState = "idle"
  private var partialCapture = false
  private var interruptionReason: String?

  func update(
    state: String,
    partialCapture: Bool,
    interruptionReason: String?
  ) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.captureState = state
      self.partialCapture = partialCapture
      self.interruptionReason = interruptionReason
      if ["recording", "paused", "partial_capture", "finalizing"].contains(state) {
        self.ensureStatusItem()
        self.rebuildMenu()
      } else {
        self.removeStatusItem()
      }
    }
  }

  func dispose() {
    DispatchQueue.main.async { [weak self] in
      self?.removeStatusItem()
    }
  }

  private func ensureStatusItem() {
    guard statusItem == nil else { return }
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.image = NSImage(
      systemSymbolName: "waveform.circle.fill",
      accessibilityDescription: "Voice2Text 会议录音"
    )
    item.button?.imagePosition = .imageLeading
    statusItem = item
  }

  private func rebuildMenu() {
    guard let statusItem else { return }
    let menu = NSMenu(title: "Voice2Text 会议录音")
    let paused = captureState == "paused"
    let finalizing = captureState == "finalizing"
    let stateTitle: String
    if interruptionReason == "system_wake_requires_resume" {
      stateTitle = "Mac 已唤醒 · 请继续录音"
    } else if interruptionReason == "system_sleep" {
      stateTitle = "系统睡眠前已安全暂停"
    } else if finalizing {
      stateTitle = "正在安全停止…"
    } else if partialCapture {
      stateTitle = paused ? "已暂停 · 部分轨道" : "录音中 · 部分轨道"
    } else {
      stateTitle = paused ? "录音已暂停" : "录音中"
    }
    let stateItem = NSMenuItem(title: stateTitle, action: nil, keyEquivalent: "")
    stateItem.isEnabled = false
    menu.addItem(stateItem)
    menu.addItem(.separator())

    let pauseResume = NSMenuItem(
      title: paused ? "继续录音" : "暂停录音",
      action: #selector(togglePause),
      keyEquivalent: ""
    )
    pauseResume.target = self
    pauseResume.isEnabled = !finalizing
    menu.addItem(pauseResume)

    let stop = NSMenuItem(
      title: "停止并保存…",
      action: #selector(confirmStop),
      keyEquivalent: ""
    )
    stop.target = self
    stop.isEnabled = !finalizing
    menu.addItem(stop)
    menu.addItem(.separator())

    let show = NSMenuItem(
      title: "返回 Voice2Text 窗口",
      action: #selector(showMainWindow),
      keyEquivalent: ""
    )
    show.target = self
    menu.addItem(show)
    statusItem.menu = menu
  }

  @objc private func togglePause() {
    onAction?(captureState == "paused" ? "resume" : "pause")
  }

  @objc private func confirmStop() {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "停止本次电脑会议？"
    alert.informativeText =
      "将安全提交双轨录音，再关闭实时草稿并排入正式转写。"
    alert.addButton(withTitle: "停止并保存")
    alert.addButton(withTitle: "继续录音")
    if alert.runModal() == .alertFirstButtonReturn {
      onAction?("stop")
    }
  }

  @objc private func showMainWindow() {
    NSApplication.shared.activate(ignoringOtherApps: true)
    for window in NSApplication.shared.windows where window.canBecomeKey {
      window.makeKeyAndOrderFront(nil)
      break
    }
  }

  private func removeStatusItem() {
    if let statusItem {
      NSStatusBar.system.removeStatusItem(statusItem)
    }
    statusItem = nil
  }
}
