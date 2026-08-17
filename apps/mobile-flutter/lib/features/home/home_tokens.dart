import 'package:flutter/material.dart';

import '../../app/theme/design_tokens.dart';

class HomePagePalette {
  HomePagePalette({
    required this.background,
    required this.surface,
    required this.surfaceActive,
    required this.text,
    required this.mutedText,
    required this.divider,
    required this.favorite,
    required this.fab,
    required this.fabShadow,
    required this.selectionFill,
    required this.selectionStroke,
  });

  final Color background;
  final Color surface;
  final Color surfaceActive;
  final Color text;
  final Color mutedText;
  final Color divider;
  final Color favorite;
  final Color fab;
  final Color fabShadow;
  final Color selectionFill;
  final Color selectionStroke;

  static HomePagePalette of(BuildContext context) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    if (isDark) {
      return HomePagePalette(
        background: const Color(0xFF0F1115),
        surface: const Color(0xFF171A21),
        surfaceActive: const Color(0x29FFFFFF),
        text: const Color(0xF2FFFFFF),
        mutedText: const Color(0x99FFFFFF),
        divider: const Color(0x1FFFFFFF),
        favorite: AppColors.danger,
        fab: AppColors.primary,
        fabShadow: const Color(0x401E6BFF),
        selectionFill: const Color(0x331E6BFF),
        selectionStroke: const Color(0x661E6BFF),
      );
    }
    return HomePagePalette(
      background: const Color(0xFFF5F5F5),
      surface: AppColors.surface,
      surfaceActive: const Color(0x0F000000),
      text: AppColors.textPrimary,
      mutedText: AppColors.textMuted,
      divider: AppColors.dividerSubtle,
      favorite: AppColors.danger,
      fab: AppColors.primary,
      fabShadow: const Color(0x1F1E6BFF),
      selectionFill: const Color(0x0D1E6BFF),
      selectionStroke: const Color(0x331E6BFF),
    );
  }
}

class HomePageMetrics {
  static const double horizontalPadding = 16;
  static const double topBarPaddingTop = 16;
  static const double topBarPaddingBottom = 8;
  static const double topBarHeight = 56;
  static const double iconActionIconSize = 24;
  static const double trailingActionIconSize = 20;
  static const double iconActionBoxSize = 36;
  static const double iconActionRadius = 12;
  static const double iconActionHoverOpacity = 0.7;
  static const double tabsPaddingVertical = 12;
  static const double tabHeight = 36;
  static const double tabRadius = 12;
  static const double panelRadius = 16;
  static const double rowHeight = 96;
  static const double rowGap = 10;
  static const double fabSize = 72;
  static const double fabRadius = 24;
  static const double fabBottomSpacing = 18;
  static const double listBottomInset = 116;
  static const double selectionListBottomInset = 24;
  static const double emptyIconSize = 52;
  static const double selectionToolbarDockHeight = 58;
  static const double selectionToolbarDockGap = 16;
  static const double actionSheetRadius = 26;
  static const double actionSheetHeaderHorizontal = 20;
  static const double actionSheetHeaderTop = 20;
  static const double actionSheetHeaderBottom = 16;
  static const double actionSheetOptionHorizontal = 20;
  static const double actionSheetOptionVertical = 16;
  static const double actionSheetOptionIconBox = 24;
  static const double actionSheetCancelVertical = 16;
}

class HomePageTextStyles {
  static TextStyle title(HomePagePalette palette) => TextStyle(
    fontSize: 30,
    fontWeight: FontWeight.w400,
    color: palette.text,
    letterSpacing: 0,
    height: 1,
  );

  static TextStyle rowTitle(HomePagePalette palette) => TextStyle(
    color: palette.text,
    fontSize: 17,
    fontWeight: FontWeight.w400,
    height: 1.52,
  );

  static TextStyle meta(HomePagePalette palette) => TextStyle(
    color: palette.mutedText,
    fontSize: 13,
    fontWeight: FontWeight.w400,
    height: 1.08,
  );

  static TextStyle tab(HomePagePalette palette) => TextStyle(
    color: palette.text,
    fontSize: 15,
    fontWeight: FontWeight.w400,
    height: 1.6,
  );

  static TextStyle tabActive(HomePagePalette palette) => TextStyle(
    color: palette.text,
    fontSize: 15,
    fontWeight: FontWeight.w400,
    height: 1.6,
  );

  static TextStyle selectionTitle(HomePagePalette palette) => TextStyle(
    color: palette.text,
    fontSize: 16,
    fontWeight: FontWeight.w400,
    height: 1.25,
  );

  static TextStyle selectionAction(HomePagePalette palette) => TextStyle(
    color: palette.text,
    fontSize: 17,
    fontWeight: FontWeight.w400,
    height: 1.53,
  );

  static TextStyle emptyText(HomePagePalette palette) => TextStyle(
    color: palette.mutedText,
    fontSize: 15,
    fontWeight: FontWeight.w400,
    height: 1.6,
  );

  static TextStyle actionSheetTitle(HomePagePalette palette) => TextStyle(
    color: palette.text,
    fontSize: 18,
    fontWeight: FontWeight.w600,
    height: 1.25,
  );

  static TextStyle actionSheetOption(HomePagePalette palette) => TextStyle(
    color: palette.text,
    fontSize: 15,
    fontWeight: FontWeight.w400,
    height: 1.2,
  );

  static TextStyle actionSheetCancel(HomePagePalette palette) => TextStyle(
    color: palette.text,
    fontSize: 15,
    fontWeight: FontWeight.w600,
    height: 1.2,
  );
}
