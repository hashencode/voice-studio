import 'dart:async';
import 'dart:io';

import 'package:processing_contracts/processing_contracts.dart';

import 'sidecar_jsonl_framer.dart';
import 'sidecar_sandbox.dart';

class SidecarLaunchConfiguration {
  const SidecarLaunchConfiguration({
    required this.roots,
    required this.launcherPath,
    required this.workerPath,
    required this.pythonPath,
    required this.engine,
    required this.expectedRuntimeId,
    required this.expectedRuntimeVersion,
    required this.requiredCapabilities,
    required this.timeout,
    required this.cpuSeconds,
    required this.memoryBytes,
    required this.outputBytes,
    this.useMacosSandbox = true,
  });

  final SidecarRoots roots;
  final String launcherPath;
  final String workerPath;
  final String pythonPath;
  final String engine;
  final String expectedRuntimeId;
  final String expectedRuntimeVersion;
  final Set<String> requiredCapabilities;
  final Duration timeout;
  final int cpuSeconds;
  final int memoryBytes;
  final int outputBytes;
  final bool useMacosSandbox;
}

class SidecarJobOutcome {
  const SidecarJobOutcome._({this.transcript, this.speakerTurns});

  final SidecarResult? transcript;
  final SidecarSpeakerTurnResult? speakerTurns;

  factory SidecarJobOutcome.transcript(SidecarResult result) =>
      SidecarJobOutcome._(transcript: result);

  factory SidecarJobOutcome.speakerTurns(SidecarSpeakerTurnResult result) =>
      SidecarJobOutcome._(speakerTurns: result);
}

class SidecarProcessClient {
  const SidecarProcessClient();

  Future<SidecarJobOutcome> run({
    required SidecarLaunchConfiguration configuration,
    required SidecarJobRequest request,
    required ProcessingCancellationToken cancellationToken,
    required void Function(ProcessingProgress progress) onProgress,
  }) async {
    final profile = SidecarSandboxProfile.macos(configuration.roots);
    final launcherArguments = <String>[
      configuration.launcherPath,
      '--job-root',
      configuration.roots.jobRoot,
      '--runtime-root',
      configuration.roots.runtimeRoot,
      '--model-root',
      configuration.roots.modelRoot,
      '--engine',
      configuration.engine,
      '--cpu-seconds',
      configuration.cpuSeconds.toString(),
      '--memory-bytes',
      configuration.memoryBytes.toString(),
      '--output-bytes',
      configuration.outputBytes.toString(),
      '--',
      configuration.pythonPath,
      configuration.workerPath,
    ];
    final executable = configuration.useMacosSandbox
        ? '/usr/bin/sandbox-exec'
        : configuration.pythonPath;
    final arguments = configuration.useMacosSandbox
        ? <String>[
            '-p',
            profile,
            configuration.pythonPath,
            ...launcherArguments,
          ]
        : launcherArguments;
    final process = await Process.start(
      executable,
      arguments,
      workingDirectory: configuration.roots.jobRoot,
      environment: const <String, String>{},
      includeParentEnvironment: false,
      runInShell: false,
    );
    final completer = Completer<SidecarJobOutcome>();
    final framer = SidecarJsonlFramer(
      maximumTotalBytes: configuration.outputBytes,
    );
    var handshakeAccepted = false;
    var capabilityAccepted = false;
    var jobSent = false;
    var lastProgress = 0.0;
    var stderrBytes = 0;
    var memoryCheckRunning = false;
    var cancellationSent = false;
    var cancellationInProgress = false;

    Future<void> terminate() async {
      try {
        Process.killPid(-process.pid, ProcessSignal.sigterm);
      } on ProcessException {
        process.kill(ProcessSignal.sigterm);
      }
      try {
        await process.exitCode.timeout(const Duration(milliseconds: 500));
        return;
      } on TimeoutException {
        // Escalate below when native work ignores the graceful signal.
      }
      try {
        Process.killPid(-process.pid, ProcessSignal.sigkill);
      } on ProcessException {
        process.kill(ProcessSignal.sigkill);
      }
      await process.exitCode;
    }

    void fail(Object error) {
      if (completer.isCompleted) return;
      completer.completeError(error);
      unawaited(terminate());
    }

    Future<void> requestCancellation(Object error) async {
      if (completer.isCompleted || cancellationInProgress) return;
      cancellationInProgress = true;
      process.stdin.writeln(
        SidecarEnvelope(
          type: SidecarMessageType.cancel,
          messageId: 'cancel-1',
          jobId: request.jobId,
          attemptId: request.attemptId,
          payload: const <String, Object?>{},
        ).encode(),
      );
      try {
        await process.stdin.flush();
        await Future<void>.delayed(const Duration(milliseconds: 50));
      } on Object {
        // Cancellation remains authoritative if the sidecar already exited.
      }
      if (!completer.isCompleted) completer.completeError(error);
      await terminate();
    }

    void sendJobIfReady() {
      if (!handshakeAccepted || !capabilityAccepted || jobSent) return;
      jobSent = true;
      process.stdin.writeln(request.toEnvelope('job-request-1').encode());
    }

    process.stderr.listen((bytes) {
      stderrBytes += bytes.length;
      if (stderrBytes > 64 * 1024) {
        fail(
          const SidecarProtocolException(
            'SIDECAR_OUTPUT_LIMIT',
            'Sidecar stderr exceeds the diagnostic limit.',
          ),
        );
      }
    }, onError: fail);
    process.stdout.listen(
      (bytes) {
        try {
          for (final line in framer.add(bytes)) {
            final envelope = SidecarEnvelope.decode(line);
            switch (envelope.type) {
              case SidecarMessageType.handshake:
                if (handshakeAccepted) {
                  throw const SidecarProtocolException(
                    'SIDECAR_HANDSHAKE_INVALID',
                    'Sidecar sent more than one handshake.',
                  );
                }
                SidecarHandshake.fromEnvelope(envelope).requireExpected(
                  expectedRuntimeId: configuration.expectedRuntimeId,
                  expectedRuntimeVersion: configuration.expectedRuntimeVersion,
                  requiredCapabilities: configuration.requiredCapabilities,
                );
                handshakeAccepted = true;
                sendJobIfReady();
                break;
              case SidecarMessageType.capability:
                final capabilities = envelope.payload['capabilities'];
                final pathRoots = envelope.payload['pathRoots'];
                const requiredRoots = <String>{'job', 'runtime', 'model'};
                if (capabilityAccepted ||
                    capabilities is! List<Object?> ||
                    !capabilities.toSet().containsAll(
                      configuration.requiredCapabilities,
                    ) ||
                    envelope.payload['networkDuringProcessing'] != false ||
                    pathRoots is! List<Object?> ||
                    pathRoots.toSet().length != requiredRoots.length ||
                    !pathRoots.toSet().containsAll(requiredRoots)) {
                  throw const SidecarProtocolException(
                    'SIDECAR_CAPABILITY_MISMATCH',
                    'Sidecar capability contract does not match.',
                  );
                }
                capabilityAccepted = true;
                sendJobIfReady();
                break;
              case SidecarMessageType.progress:
                if (envelope.jobId != request.jobId ||
                    envelope.attemptId != request.attemptId) {
                  throw const SidecarProtocolException(
                    'SIDECAR_STALE_RESULT',
                    'Sidecar progress belongs to a stale attempt.',
                  );
                }
                final phase = envelope.payload['phase'];
                final fraction = envelope.payload['fraction'];
                if (phase is! String ||
                    fraction is! num ||
                    fraction < lastProgress ||
                    fraction < 0 ||
                    fraction > 1) {
                  throw const SidecarProtocolException(
                    'SIDECAR_PROGRESS_INVALID',
                    'Sidecar progress is invalid or non-monotonic.',
                  );
                }
                lastProgress = fraction.toDouble();
                onProgress(
                  ProcessingProgress(phase: phase, fraction: lastProgress),
                );
                break;
              case SidecarMessageType.result:
                final outcome = request.capability == 'diarization'
                    ? SidecarJobOutcome.speakerTurns(
                        SidecarSpeakerTurnResult.fromEnvelope(
                          envelope,
                          expectedJobId: request.jobId,
                          expectedAttemptId: request.attemptId,
                          durationSeconds: request.durationSeconds,
                          maxSegments: request.maxSegments,
                        ),
                      )
                    : SidecarJobOutcome.transcript(
                        SidecarResult.fromEnvelope(
                          envelope,
                          expectedJobId: request.jobId,
                          expectedAttemptId: request.attemptId,
                          durationSeconds: request.durationSeconds,
                          maxSegments: request.maxSegments,
                        ),
                      );
                if (!completer.isCompleted) completer.complete(outcome);
                process.stdin.writeln(
                  SidecarEnvelope(
                    type: SidecarMessageType.shutdown,
                    messageId: 'shutdown-1',
                    payload: const <String, Object?>{},
                  ).encode(),
                );
                break;
              case SidecarMessageType.error:
                if (envelope.jobId != request.jobId ||
                    envelope.attemptId != request.attemptId) {
                  throw const SidecarProtocolException(
                    'SIDECAR_STALE_RESULT',
                    'Sidecar error belongs to a stale attempt.',
                  );
                }
                throw SidecarProtocolException(
                  envelope.payload['code'] is String
                      ? envelope.payload['code']! as String
                      : 'SIDECAR_JOB_FAILED',
                  'Sidecar job failed without exposing private diagnostics.',
                );
              case SidecarMessageType.job ||
                  SidecarMessageType.cancel ||
                  SidecarMessageType.shutdown:
                throw const SidecarProtocolException(
                  'SIDECAR_MESSAGE_TYPE_UNSUPPORTED',
                  'Sidecar sent a controller-only message.',
                );
            }
          }
        } on Object catch (error) {
          fail(error);
        }
      },
      onError: fail,
      onDone: () {
        try {
          framer.close();
        } on Object catch (error) {
          fail(error);
        }
      },
      cancelOnError: true,
    );
    unawaited(
      process.exitCode.then((code) {
        if (!completer.isCompleted && !cancellationInProgress) {
          fail(
            SidecarProtocolException(
              'SIDECAR_PROCESS_EXITED',
              'Sidecar exited before a validated result (code $code).',
            ),
          );
        }
      }),
    );
    final timeout = Timer(configuration.timeout, () {
      fail(const ProcessingTimedOut());
    });
    final cancellationPoll = Timer.periodic(const Duration(milliseconds: 50), (
      _,
    ) {
      if (cancellationToken.isCancelled && !cancellationSent) {
        cancellationSent = true;
        unawaited(
          requestCancellation(
            cancellationToken.deadlineExceeded
                ? const ProcessingTimedOut()
                : const ProcessingCancelled(),
          ),
        );
      }
    });
    final memoryPoll = Timer.periodic(const Duration(milliseconds: 200), (_) {
      if (memoryCheckRunning || completer.isCompleted) return;
      memoryCheckRunning = true;
      unawaited(
        Process.run('/bin/ps', <String>[
              '-o',
              'rss=',
              '-p',
              process.pid.toString(),
            ])
            .then((result) {
              final residentKilobytes = int.tryParse(
                result.stdout.toString().trim(),
              );
              if (residentKilobytes != null &&
                  residentKilobytes * 1024 > configuration.memoryBytes) {
                fail(
                  const SidecarProtocolException(
                    'SIDECAR_MEMORY_LIMIT',
                    'Sidecar exceeded the resident-memory limit.',
                  ),
                );
              }
            })
            .whenComplete(() {
              memoryCheckRunning = false;
            }),
      );
    });
    try {
      return await completer.future;
    } finally {
      timeout.cancel();
      cancellationPoll.cancel();
      memoryPoll.cancel();
      await process.stdin.close();
      try {
        await process.exitCode.timeout(const Duration(seconds: 2));
      } on TimeoutException {
        process.kill(ProcessSignal.sigkill);
        await process.exitCode;
      }
    }
  }
}
