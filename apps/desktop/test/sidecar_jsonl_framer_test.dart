import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:processing_contracts/processing_contracts.dart';
import 'package:voice2text_desktop/features/processing/sidecar/sidecar_jsonl_framer.dart';

void main() {
  test('JSONL framer handles split lines and rejects incomplete output', () {
    final framer = SidecarJsonlFramer(maximumLineBytes: 20);
    expect(framer.add(utf8.encode('{"a":')), isEmpty);
    expect(framer.add(utf8.encode('1}\n')), <String>['{"a":1}']);
    framer.add(utf8.encode('partial'));
    expect(
      framer.close,
      throwsA(
        isA<SidecarProtocolException>().having(
          (error) => error.code,
          'code',
          'SIDECAR_INVALID_JSON',
        ),
      ),
    );
  });

  test('JSONL framer enforces per-line and session byte limits', () {
    expect(
      () => SidecarJsonlFramer(maximumLineBytes: 4).add(utf8.encode('12345')),
      throwsA(isA<SidecarProtocolException>()),
    );
    expect(
      () => SidecarJsonlFramer(maximumTotalBytes: 4).add(utf8.encode('12345')),
      throwsA(isA<SidecarProtocolException>()),
    );
  });
}
