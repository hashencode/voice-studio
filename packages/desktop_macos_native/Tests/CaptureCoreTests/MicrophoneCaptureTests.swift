import AVFoundation
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

  func testEquivalentPCMFormatsProduceMatchingRMSAndPeak() throws {
    let samples: [Double] = [-0.5, 0.25, 0.5, -0.25]
    let floatResult = try XCTUnwrap(meterResult(format: .pcmFormatFloat32, samples: samples))
    let int16Result = try XCTUnwrap(meterResult(format: .pcmFormatInt16, samples: samples))
    let int32Result = try XCTUnwrap(meterResult(format: .pcmFormatInt32, samples: samples))

    XCTAssertEqual(floatResult.normalizedPeak, 0.5, accuracy: 0.0001)
    XCTAssertEqual(floatResult.normalizedRMS, sqrt(0.15625), accuracy: 0.0001)
    XCTAssertEqual(int16Result.normalizedPeak, floatResult.normalizedPeak, accuracy: 0.0001)
    XCTAssertEqual(int16Result.normalizedRMS, floatResult.normalizedRMS, accuracy: 0.0001)
    XCTAssertEqual(int32Result.normalizedPeak, floatResult.normalizedPeak, accuracy: 0.0001)
    XCTAssertEqual(int32Result.normalizedRMS, floatResult.normalizedRMS, accuracy: 0.0001)
  }

  func testPlanarAndInterleavedLayoutsHonorStrideAndMergeChannels() throws {
    let channels = [
      [0.1, -0.1, 0.1, -0.1],
      [0.75, -0.25, 0.75, -0.25],
    ]
    let planar = try XCTUnwrap(
      meterResult(format: .pcmFormatFloat32, channels: channels, interleaved: false)
    )
    let interleaved = try XCTUnwrap(
      meterResult(format: .pcmFormatFloat32, channels: channels, interleaved: true)
    )

    XCTAssertEqual(planar.normalizedPeak, 0.75, accuracy: 0.0001)
    XCTAssertEqual(planar.normalizedRMS, sqrt(0.3125), accuracy: 0.0001)
    XCTAssertEqual(interleaved.normalizedPeak, planar.normalizedPeak, accuracy: 0.0001)
    XCTAssertEqual(interleaved.normalizedRMS, planar.normalizedRMS, accuracy: 0.0001)
  }

  func testMeterDistinguishesNoFramesZeroEnergyAndUnsupportedFormat() throws {
    let empty = try makeBuffer(format: .pcmFormatFloat32, channels: [[]], interleaved: false)
    guard case .noFrames = MicrophonePCMBufferMeter.measure(empty) else {
      return XCTFail("zero frame buffers must remain distinguishable")
    }

    let silent = try makeBuffer(
      format: .pcmFormatFloat32,
      channels: [[0, 0, 0]],
      interleaved: false
    )
    guard case let .samples(frames, rms, peak) = MicrophonePCMBufferMeter.measure(silent) else {
      return XCTFail("silent samples must remain valid samples")
    }
    XCTAssertEqual(frames, 3)
    XCTAssertEqual(rms, 0)
    XCTAssertEqual(peak, 0)

    let unsupportedFormat = try XCTUnwrap(
      AVAudioFormat(
        commonFormat: .pcmFormatFloat64,
        sampleRate: 48_000,
        channels: 1,
        interleaved: false
      )
    )
    let unsupported = try XCTUnwrap(
      AVAudioPCMBuffer(pcmFormat: unsupportedFormat, frameCapacity: 1)
    )
    unsupported.frameLength = 1
    guard case .unsupportedFormat = MicrophonePCMBufferMeter.measure(unsupported) else {
      return XCTFail("unknown PCM formats must not look like silence")
    }
  }

  func testIntegerMinimumValuesNormalizeWithoutOverflow() throws {
    let int16 = try XCTUnwrap(
      meterResult(format: .pcmFormatInt16, integerMinimum: true)
    )
    let int32 = try XCTUnwrap(
      meterResult(format: .pcmFormatInt32, integerMinimum: true)
    )

    XCTAssertEqual(int16.normalizedPeak, 1, accuracy: 0.0001)
    XCTAssertEqual(int16.normalizedRMS, 1, accuracy: 0.0001)
    XCTAssertEqual(int32.normalizedPeak, 1, accuracy: 0.0001)
    XCTAssertEqual(int32.normalizedRMS, 1, accuracy: 0.0001)
  }

  func testMeterWindowIsConsumedOnceAndExpiresAfterRetentionLimit() {
    var accumulator = MicrophoneMeterAccumulator(retentionNanoseconds: 250_000_000)
    accumulator.record(normalizedRMS: 0.4, normalizedPeak: 0.8, at: 1_000_000_000)
    accumulator.record(normalizedRMS: 0.1, normalizedPeak: 0.2, at: 1_021_000_000)

    let first = accumulator.consume(at: 1_050_000_000)
    XCTAssertEqual(first.normalizedRMS, 0.4)
    XCTAssertEqual(first.normalizedPeak, 0.8)
    let second = accumulator.consume(at: 1_050_000_001)
    XCTAssertEqual(second.normalizedRMS, 0)
    XCTAssertEqual(second.normalizedPeak, 0)

    accumulator.record(normalizedRMS: 0.5, normalizedPeak: 0.7, at: 2_000_000_000)
    let expired = accumulator.consume(at: 2_250_000_001)
    XCTAssertEqual(expired.normalizedRMS, 0)
    XCTAssertEqual(expired.normalizedPeak, 0)
  }

  private func meterResult(
    format: AVAudioCommonFormat,
    samples: [Double]
  ) throws -> (normalizedRMS: Double, normalizedPeak: Double)? {
    try meterResult(format: format, channels: [samples], interleaved: false)
  }

  private func meterResult(
    format: AVAudioCommonFormat,
    channels: [[Double]],
    interleaved: Bool
  ) throws -> (normalizedRMS: Double, normalizedPeak: Double)? {
    let buffer = try makeBuffer(format: format, channels: channels, interleaved: interleaved)
    guard case let .samples(_, rms, peak) = MicrophonePCMBufferMeter.measure(buffer) else {
      return nil
    }
    return (rms, peak)
  }

  private func meterResult(
    format: AVAudioCommonFormat,
    integerMinimum: Bool
  ) throws -> (normalizedRMS: Double, normalizedPeak: Double)? {
    let buffer = try makeBuffer(format: format, channels: [[0]], interleaved: false)
    if integerMinimum, format == .pcmFormatInt16 {
      buffer.int16ChannelData![0][0] = Int16.min
    } else if integerMinimum, format == .pcmFormatInt32 {
      buffer.int32ChannelData![0][0] = Int32.min
    }
    guard case let .samples(_, rms, peak) = MicrophonePCMBufferMeter.measure(buffer) else {
      return nil
    }
    return (rms, peak)
  }

  private func makeBuffer(
    format commonFormat: AVAudioCommonFormat,
    channels: [[Double]],
    interleaved: Bool
  ) throws -> AVAudioPCMBuffer {
    let frameCount = channels.first?.count ?? 0
    XCTAssertTrue(channels.allSatisfy { $0.count == frameCount })
    let format = try XCTUnwrap(
      AVAudioFormat(
        commonFormat: commonFormat,
        sampleRate: 48_000,
        channels: AVAudioChannelCount(channels.count),
        interleaved: interleaved
      )
    )
    let buffer = try XCTUnwrap(
      AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(max(1, frameCount)))
    )
    buffer.frameLength = AVAudioFrameCount(frameCount)
    let audioBuffers = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
    let stride = Int(buffer.stride)
    for channel in channels.indices {
      let audioBufferIndex = interleaved ? 0 : channel
      guard let rawData = audioBuffers[audioBufferIndex].mData else {
        throw XCTSkip("AVAudioPCMBuffer did not allocate sample memory")
      }
      for frame in 0..<frameCount {
        let offset = frame * stride + (interleaved ? channel : 0)
        switch commonFormat {
        case .pcmFormatFloat32:
          rawData.assumingMemoryBound(to: Float.self)[offset] = Float(channels[channel][frame])
        case .pcmFormatInt16:
          rawData.assumingMemoryBound(to: Int16.self)[offset] = Int16(
            (channels[channel][frame] * 32_768).rounded(.towardZero)
          )
        case .pcmFormatInt32:
          rawData.assumingMemoryBound(to: Int32.self)[offset] = Int32(
            (channels[channel][frame] * 2_147_483_648).rounded(.towardZero)
          )
        default:
          break
        }
      }
    }
    return buffer
  }
}
