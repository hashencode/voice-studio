import XCTest
@testable import CaptureCore

final class MicrophoneCaptureTests: XCTestCase {
  func testCoreAudioInputsRemainVisibleToCapturePreflight() {
    let devices = MicrophoneCapture.captureDevices(
      from: [
        CoreAudioInputDevice(
          audioDeviceID: 1,
          uniqueID: "built-in",
          name: "Mac microphone"
        ),
        CoreAudioInputDevice(
          audioDeviceID: 2,
          uniqueID: "external",
          name: "External microphone"
        ),
      ],
      defaultAudioDeviceID: 2
    )

    XCTAssertEqual(devices.map(\.id), ["built-in", "external"])
    XCTAssertEqual(devices.map(\.name), ["Mac microphone", "External microphone"])
    XCTAssertEqual(devices.map(\.isDefault), [false, true])
  }
}
