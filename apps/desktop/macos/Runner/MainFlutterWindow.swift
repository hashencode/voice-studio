import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  private var secureLocalImportPlugin: SecureLocalImportPlugin?
  private var companionDiscoveryPlugin: CompanionDiscoveryPlugin?

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

    super.awakeFromNib()
  }
}
