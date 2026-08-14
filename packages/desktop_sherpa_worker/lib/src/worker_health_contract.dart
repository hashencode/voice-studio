const int desktopWorkerHealthProtocolVersion = 1;
const String desktopWorkerHealthProtocol = 'desktop-sherpa-worker-health/v1';

void validateDesktopWorkerHealthRequest(Map<String, Object?> request) {
  const allowedKeys = <String>{
    'schemaVersion',
    'operation',
    'expectedProtocolVersion',
  };
  if (request.keys.any((key) => !allowedKeys.contains(key)) ||
      request['schemaVersion'] != desktopWorkerHealthProtocolVersion ||
      request['operation'] != 'health' ||
      request['expectedProtocolVersion'] !=
          desktopWorkerHealthProtocolVersion) {
    throw const FormatException('incompatible worker health protocol');
  }
}
