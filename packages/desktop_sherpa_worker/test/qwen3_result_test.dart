import 'package:desktop_sherpa_worker/desktop_sherpa_worker.dart';
import 'package:test/test.dart';

void main() {
  test('repairs literal control characters inside Qwen3 text', () {
    final result = decodeQwen3ResultJson(
      '{"lang":"","emotion":"","event":"","text":"提纲：\n第一项\t完成",'
      '"tokens":[],"timestamps":[]}',
    );

    expect(result['text'], '提纲：\n第一项\t完成');
  });

  test('preserves valid Qwen3 JSON escapes', () {
    final result = decodeQwen3ResultJson(
      r'{"lang":"","emotion":"","event":"","text":"a \"quote\"\\path",'
      r'"tokens":[],"timestamps":[]}',
    );

    expect(result['text'], 'a "quote"\\path');
  });
}
