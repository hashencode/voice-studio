import 'dart:convert';

enum BenchmarkCandidateFamily {
  streamingTransducer('streaming_transducer', <String>{
    'encoder',
    'decoder',
    'joiner',
    'tokens',
  }),
  offlineParaformer('offline_paraformer', <String>{'model', 'tokens'}),
  funasrNano('funasr_nano', <String>{
    'encoderAdaptor',
    'llm',
    'embedding',
    'tokenizer',
  }),
  fireRedAsrCtc('firered_asr_ctc', <String>{'model', 'tokens'});

  const BenchmarkCandidateFamily(this.manifestValue, this.requiredModelRoles);

  final String manifestValue;
  final Set<String> requiredModelRoles;

  static BenchmarkCandidateFamily parse(Object? value) {
    for (final family in values) {
      if (family.manifestValue == value) return family;
    }
    throw const FormatException('unsupported benchmark candidate family');
  }
}

class CandidateModelFile {
  const CandidateModelFile({required this.path, required this.sha256});

  factory CandidateModelFile.fromJson(Object? value) {
    if (value is! Map<String, Object?>) {
      throw const FormatException('model file must be an object');
    }
    _requireExactKeys(value, const <String>{'path', 'sha256'}, 'model file');
    final path = value['path'];
    final sha256 = value['sha256'];
    if (path is! String || path.isEmpty || !_isSha256(sha256)) {
      throw const FormatException('model file identity is invalid');
    }
    return CandidateModelFile(path: path, sha256: sha256! as String);
  }

  final String path;
  final String sha256;
}

class CandidateCapabilities {
  const CandidateCapabilities({
    required this.streaming,
    required this.timestamps,
    required this.partialResults,
    required this.endpointing,
    required this.hotwords,
    required this.punctuation,
    required this.itn,
    required this.seededGeneration,
  });

  factory CandidateCapabilities.fromJson(Object? value) {
    if (value is! Map<String, Object?>) {
      throw const FormatException('capabilities must be an object');
    }
    const fields = <String>{
      'streaming',
      'timestamps',
      'partialResults',
      'endpointing',
      'hotwords',
      'punctuation',
      'itn',
      'seededGeneration',
    };
    _requireExactKeys(value, fields, 'capabilities');
    if (value.values.any((item) => item is! bool)) {
      throw const FormatException('capabilities must be booleans');
    }
    return CandidateCapabilities(
      streaming: value['streaming']! as bool,
      timestamps: value['timestamps']! as bool,
      partialResults: value['partialResults']! as bool,
      endpointing: value['endpointing']! as bool,
      hotwords: value['hotwords']! as bool,
      punctuation: value['punctuation']! as bool,
      itn: value['itn']! as bool,
      seededGeneration: value['seededGeneration']! as bool,
    );
  }

  final bool streaming;
  final bool timestamps;
  final bool partialResults;
  final bool endpointing;
  final bool hotwords;
  final bool punctuation;
  final bool itn;
  final bool seededGeneration;

  Map<String, Object?> toJson() => <String, Object?>{
    'streaming': streaming,
    'timestamps': timestamps,
    'partialResults': partialResults,
    'endpointing': endpointing,
    'hotwords': hotwords,
    'punctuation': punctuation,
    'itn': itn,
    'seededGeneration': seededGeneration,
  };
}

class CandidateWorkerRequest {
  const CandidateWorkerRequest({
    required this.candidateId,
    required this.family,
    required this.profileId,
    required this.sourcePath,
    required this.sourceSha256,
    required this.modelFiles,
    required this.effectiveConfig,
    required this.capabilities,
    required this.expectSpeech,
    required this.settleMilliseconds,
  });

  factory CandidateWorkerRequest.fromJson(Map<String, Object?> json) {
    _requireExactKeys(json, const <String>{
      'schemaVersion',
      'candidateId',
      'family',
      'profileId',
      'sourcePath',
      'sourceSha256',
      'modelFiles',
      'effectiveConfig',
      'capabilities',
      'expectSpeech',
      'settleMilliseconds',
    }, 'worker request');
    if (json['schemaVersion'] != 2) {
      throw const FormatException('worker request schemaVersion must be 2');
    }
    final candidateId = json['candidateId'];
    final profileId = json['profileId'];
    final sourcePath = json['sourcePath'];
    final settleMilliseconds = json['settleMilliseconds'];
    if (candidateId is! String ||
        candidateId.length < 12 ||
        const <String>{
          'funasr',
          'paraformer',
          'zipformer',
        }.contains(candidateId)) {
      throw const FormatException('candidate identity is ambiguous');
    }
    if (profileId is! String ||
        !const <String>{'recommended', 'fixed-resource'}.contains(profileId)) {
      throw const FormatException('profileId is invalid');
    }
    if (sourcePath is! String ||
        sourcePath.isEmpty ||
        !_isSha256(json['sourceSha256'])) {
      throw const FormatException('source identity is invalid');
    }
    if (settleMilliseconds is! int ||
        settleMilliseconds < 0 ||
        settleMilliseconds > 5000) {
      throw const FormatException('settleMilliseconds is invalid');
    }
    if (json['expectSpeech'] is! bool) {
      throw const FormatException('expectSpeech must be a boolean');
    }
    final family = BenchmarkCandidateFamily.parse(json['family']);
    final modelFilesValue = json['modelFiles'];
    if (modelFilesValue is! Map<String, Object?>) {
      throw const FormatException('modelFiles must be an object');
    }
    if (modelFilesValue.keys
            .toSet()
            .difference(family.requiredModelRoles)
            .isNotEmpty ||
        family.requiredModelRoles
            .difference(modelFilesValue.keys.toSet())
            .isNotEmpty) {
      throw const FormatException('model file roles do not match the family');
    }
    final modelFiles = <String, CandidateModelFile>{
      for (final entry in modelFilesValue.entries)
        entry.key: CandidateModelFile.fromJson(entry.value),
    };
    final effectiveConfig = json['effectiveConfig'];
    if (effectiveConfig is! Map<String, Object?>) {
      throw const FormatException('effectiveConfig must be an object');
    }
    return CandidateWorkerRequest(
      candidateId: candidateId,
      family: family,
      profileId: profileId,
      sourcePath: sourcePath,
      sourceSha256: json['sourceSha256']! as String,
      modelFiles: Map<String, CandidateModelFile>.unmodifiable(modelFiles),
      effectiveConfig: Map<String, Object?>.unmodifiable(effectiveConfig),
      capabilities: CandidateCapabilities.fromJson(json['capabilities']),
      expectSpeech: json['expectSpeech']! as bool,
      settleMilliseconds: settleMilliseconds,
    );
  }

  static CandidateWorkerRequest decodeLine(String line) {
    final decoded = jsonDecode(line);
    if (decoded is! Map<String, Object?>) {
      throw const FormatException('worker request must be a JSON object');
    }
    return CandidateWorkerRequest.fromJson(decoded);
  }

  final String candidateId;
  final BenchmarkCandidateFamily family;
  final String profileId;
  final String sourcePath;
  final String sourceSha256;
  final Map<String, CandidateModelFile> modelFiles;
  final Map<String, Object?> effectiveConfig;
  final CandidateCapabilities capabilities;
  final bool expectSpeech;
  final int settleMilliseconds;
}

bool _isSha256(Object? value) =>
    value is String && RegExp(r'^[0-9a-f]{64}$').hasMatch(value);

void _requireExactKeys(
  Map<String, Object?> value,
  Set<String> expected,
  String location,
) {
  if (value.keys.toSet().difference(expected).isNotEmpty ||
      expected.difference(value.keys.toSet()).isNotEmpty) {
    throw FormatException('$location fields mismatch');
  }
}
