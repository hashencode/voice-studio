import 'dart:math' as math;

import 'package:flutter/animation.dart';
import 'package:flutter/painting.dart';

abstract final class CodexMetrics {
  static const double space = 4;
  static const double toolbarHeight = 46;
  static const double toolbarSmallHeight = 36;
  static const double toolbarPaneHeight = 40;
  static const double composerSingleLineButton = 28;
  static const double composerSingleLineButtonSmall = 20;
  static const double composerWidth = 768;
  static const double railWidth = 52;

  /// CSS: clamp(240px, 275px, min(520px, calc(100vw - 320px))).
  static double sidebarWidth(double viewportWidth) {
    final upperBound = math.min(520.0, viewportWidth - 320.0);
    return math.max(240.0, math.min(275.0, upperBound));
  }
}

abstract final class CodexRadii {
  static const double xxs = 2;
  static const double xs = 4;
  static const double sm = 6;
  static const double md = 8;
  static const double lg = 10;
  static const double xl = 12;
  static const double xxl = 16;
  static const double xxxl = 20;
  static const double xxxxl = 24;
  static const double composerSingleLine = 22;
  static const double full = 9999;
}

abstract final class CodexTypography {
  static const double xs = 11;
  static const double sm = 12;
  static const double base = 14;
  static const double lg = 16;
  static const double xl = 28;
  static const double xxl = 36;
  static const double xxxl = 48;
  static const double xxxxl = 72;
  static const double headingSmall = 18;
  static const double headingMedium = 20;
  static const double headingLarge = 24;
}

abstract final class CodexMotion {
  static const basic = Duration(milliseconds: 150);
  static const relaxed = Duration(milliseconds: 300);
  static const standard = Cubic(0.4, 0, 0.2, 1);
  static const enter = Cubic(0.19, 1, 0.22, 1);
  static const enterSnappy = Cubic(0.23, 1, 0.32, 1);
}

abstract final class CodexShadows {
  static const small = <BoxShadow>[
    BoxShadow(
      color: Color(0x14000000),
      offset: Offset(0, 1),
      blurRadius: 2,
      spreadRadius: -1,
    ),
  ];
  static const medium = <BoxShadow>[
    BoxShadow(
      color: Color(0x14000000),
      offset: Offset(0, 2),
      blurRadius: 4,
      spreadRadius: -1,
    ),
  ];
  static const large = <BoxShadow>[
    BoxShadow(
      color: Color(0x1A000000),
      offset: Offset(0, 4),
      blurRadius: 8,
      spreadRadius: -2,
    ),
  ];
  static const extraLarge = <BoxShadow>[
    BoxShadow(
      color: Color(0x1F000000),
      offset: Offset(0, 8),
      blurRadius: 16,
      spreadRadius: -4,
    ),
  ];
  static const extraExtraLarge = <BoxShadow>[
    BoxShadow(
      color: Color(0x30000000),
      offset: Offset(0, 16),
      blurRadius: 32,
      spreadRadius: -8,
    ),
  ];
  static const hairline = <BoxShadow>[
    BoxShadow(color: Color(0x1A000000), spreadRadius: .5),
  ];
}
