import 'package:codex_ui_reproduction/src/design/codex_metrics.dart';
import 'package:codex_ui_reproduction/src/design/codex_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Codex renderer metrics', () {
    test('preserves the compiled spacing and radius scales', () {
      expect(CodexMetrics.space, 4);
      expect(CodexRadii.xxs, 2);
      expect(CodexRadii.xs, 4);
      expect(CodexRadii.sm, 6);
      expect(CodexRadii.md, 8);
      expect(CodexRadii.lg, 10);
      expect(CodexRadii.xl, 12);
      expect(CodexRadii.xxl, 16);
      expect(CodexRadii.xxxl, 20);
      expect(CodexRadii.xxxxl, 24);
      expect(CodexRadii.composerSingleLine, 22);
    });

    test('preserves renderer typography and toolbar dimensions', () {
      expect(CodexTypography.xs, 11);
      expect(CodexTypography.sm, 12);
      expect(CodexTypography.base, 14);
      expect(CodexTypography.lg, 16);
      expect(CodexTypography.headingSmall, 18);
      expect(CodexTypography.headingMedium, 20);
      expect(CodexTypography.headingLarge, 24);
      expect(CodexMetrics.toolbarHeight, 46);
      expect(CodexMetrics.toolbarSmallHeight, 36);
      expect(CodexMetrics.toolbarPaneHeight, 40);
    });

    test('uses the compiled responsive sidebar clamp', () {
      expect(CodexMetrics.sidebarWidth(500), 240);
      expect(CodexMetrics.sidebarWidth(900), 275);
      expect(CodexMetrics.sidebarWidth(1500), 275);
    });

    test('preserves renderer transition timing', () {
      expect(CodexMotion.basic, const Duration(milliseconds: 150));
      expect(CodexMotion.relaxed, const Duration(milliseconds: 300));
      expect(CodexMotion.standard, const Cubic(0.4, 0, 0.2, 1));
      expect(CodexMotion.enter, const Cubic(0.19, 1, 0.22, 1));
    });
  });

  group('Codex semantic themes', () {
    test('provide complete light and dark contracts', () {
      expect(CodexThemeData.light.brightness, Brightness.light);
      expect(CodexThemeData.dark.brightness, Brightness.dark);
      expect(CodexThemeData.light.mainSurface, isNot(Colors.transparent));
      expect(CodexThemeData.dark.mainSurface, isNot(Colors.transparent));
      expect(CodexThemeData.light.dropdownSurface, isNot(Colors.transparent));
      expect(CodexThemeData.dark.dropdownSurface, isNot(Colors.transparent));
      expect(CodexThemeData.light.foreground, isNot(Colors.transparent));
      expect(CodexThemeData.dark.foreground, isNot(Colors.transparent));
    });
  });

  test('shadow recipes match the compiled renderer', () {
    expect(CodexShadows.small.single.offset, const Offset(0, 1));
    expect(CodexShadows.small.single.blurRadius, 2);
    expect(CodexShadows.medium.single.offset, const Offset(0, 2));
    expect(CodexShadows.large.single.offset, const Offset(0, 4));
    expect(CodexShadows.extraLarge.single.offset, const Offset(0, 8));
    expect(CodexShadows.extraExtraLarge.single.offset, const Offset(0, 16));
  });
}
