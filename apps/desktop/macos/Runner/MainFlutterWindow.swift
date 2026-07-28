import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  private var secureLocalImportPlugin: SecureLocalImportPlugin?
  private var companionDiscoveryPlugin: CompanionDiscoveryPlugin?
  private var desktopCapturePlugin: DesktopCapturePlugin?

  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    RegisterGeneratedPlugins(registry: flutterViewController)
    secureLocalImportPlugin = SecureLocalImportPlugin(
      messenger: flutterViewController.engine.binaryMessenger
    )
    companionDiscoveryPlugin = CompanionDiscoveryPlugin(
      messenger: flutterViewController.engine.binaryMessenger
    )
    desktopCapturePlugin = DesktopCapturePlugin(
      messenger: flutterViewController.engine.binaryMessenger
    )

    super.awakeFromNib()

#if DEBUG
    if ProcessInfo.processInfo.arguments.contains(
      "--voice2text-u11-capture-smoke"
    ) {
      makeKeyAndOrderFront(nil)
      NSApplication.shared.activate(ignoringOtherApps: true)
      desktopCapturePlugin?.runDevelopmentSmoke()
    } else if ProcessInfo.processInfo.arguments.contains(
      "--voice2text-u11-capture-durability-probe"
    ) {
      makeKeyAndOrderFront(nil)
      NSApplication.shared.activate(ignoringOtherApps: true)
      desktopCapturePlugin?.runDevelopmentDurabilityProbe()
    } else if ProcessInfo.processInfo.arguments.contains(
      "--voice2text-u12-crash-probe"
    ) {
      makeKeyAndOrderFront(nil)
      NSApplication.shared.activate(ignoringOtherApps: true)
      desktopCapturePlugin?.runDevelopmentDurabilityProbe()
    } else if ProcessInfo.processInfo.arguments.contains(
      "--voice2text-u12-crash-recovery"
    ) {
      desktopCapturePlugin?.runDevelopmentCrashRecovery()
    }
#endif
  }
}
