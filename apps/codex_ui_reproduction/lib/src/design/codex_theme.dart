import 'package:flutter/material.dart';

@immutable
class CodexThemeData extends ThemeExtension<CodexThemeData> {
  const CodexThemeData({
    required this.brightness,
    required this.mainSurface,
    required this.surfaceUnder,
    required this.panel,
    required this.control,
    required this.controlOpaque,
    required this.elevatedPrimary,
    required this.elevatedPrimaryOpaque,
    required this.elevatedSecondary,
    required this.elevatedSecondaryOpaque,
    required this.dropdownSurface,
    required this.foreground,
    required this.foregroundSecondary,
    required this.foregroundTertiary,
    required this.iconPrimary,
    required this.iconSecondary,
    required this.iconTertiary,
    required this.border,
    required this.borderHeavy,
    required this.borderLight,
    required this.hover,
    required this.active,
    required this.accent,
    required this.danger,
    required this.added,
    required this.skill,
    required this.scrim,
  });

  final Brightness brightness;
  final Color mainSurface;
  final Color surfaceUnder;
  final Color panel;
  final Color control;
  final Color controlOpaque;
  final Color elevatedPrimary;
  final Color elevatedPrimaryOpaque;
  final Color elevatedSecondary;
  final Color elevatedSecondaryOpaque;
  final Color dropdownSurface;
  final Color foreground;
  final Color foregroundSecondary;
  final Color foregroundTertiary;
  final Color iconPrimary;
  final Color iconSecondary;
  final Color iconTertiary;
  final Color border;
  final Color borderHeavy;
  final Color borderLight;
  final Color hover;
  final Color active;
  final Color accent;
  final Color danger;
  final Color added;
  final Color skill;
  final Color scrim;

  // Values are the default chrome seed and generated semantic variables from
  // CodexDesktop-Rebuild 26.721.81911.
  static const light = CodexThemeData(
    brightness: Brightness.light,
    mainSurface: Color(0xFFFFFFFF),
    surfaceUnder: Color(0xFFF6F6F6),
    panel: Color(0xFFFFFFFF),
    control: Color.fromRGBO(255, 255, 255, .96),
    controlOpaque: Color(0xFFFFFFFF),
    elevatedPrimary: Color.fromRGBO(255, 255, 255, .96),
    elevatedPrimaryOpaque: Color(0xFFFFFFFF),
    elevatedSecondary: Color.fromRGBO(255, 255, 255, .96),
    elevatedSecondaryOpaque: Color(0xFFFFFFFF),
    dropdownSurface: Color.fromRGBO(255, 255, 255, .90),
    foreground: Color(0xFF1A1C1F),
    foregroundSecondary: Color.fromRGBO(26, 28, 31, .695),
    foregroundTertiary: Color.fromRGBO(26, 28, 31, .495),
    iconPrimary: Color(0xFF1A1C1F),
    iconSecondary: Color.fromRGBO(26, 28, 31, .695),
    iconTertiary: Color.fromRGBO(26, 28, 31, .495),
    border: Color.fromRGBO(26, 28, 31, .078),
    borderHeavy: Color.fromRGBO(26, 28, 31, .117),
    borderLight: Color.fromRGBO(26, 28, 31, .049),
    hover: Color.fromRGBO(26, 28, 31, .098),
    active: Color.fromRGBO(26, 28, 31, .196),
    accent: Color(0xFF339CFF),
    danger: Color(0xFFBA2623),
    added: Color(0xFF00A240),
    skill: Color(0xFF924FF7),
    scrim: Color.fromRGBO(0, 0, 0, .098),
  );

  static const dark = CodexThemeData(
    brightness: Brightness.dark,
    mainSurface: Color(0xFF181818),
    surfaceUnder: Color(0xFF141414),
    panel: Color(0xFF232323),
    control: Color.fromRGBO(45, 45, 45, .96),
    controlOpaque: Color(0xFF2D2D2D),
    elevatedPrimary: Color.fromRGBO(54, 54, 54, .96),
    elevatedPrimaryOpaque: Color(0xFF363636),
    elevatedSecondary: Color.fromRGBO(255, 255, 255, .032),
    elevatedSecondaryOpaque: Color(0xFF282828),
    dropdownSurface: Color.fromRGBO(45, 45, 45, .90),
    foreground: Color(0xFFFFFFFF),
    foregroundSecondary: Color.fromRGBO(255, 255, 255, .71),
    foregroundTertiary: Color.fromRGBO(255, 255, 255, .498),
    iconPrimary: Color.fromRGBO(255, 255, 255, .96),
    iconSecondary: Color.fromRGBO(255, 255, 255, .71),
    iconTertiary: Color.fromRGBO(255, 255, 255, .51),
    border: Color.fromRGBO(255, 255, 255, .084),
    borderHeavy: Color.fromRGBO(255, 255, 255, .156),
    borderLight: Color.fromRGBO(255, 255, 255, .042),
    hover: Color.fromRGBO(255, 255, 255, .068),
    active: Color.fromRGBO(255, 255, 255, .10),
    accent: Color(0xFF339CFF),
    danger: Color(0xFFFA423E),
    added: Color(0xFF40C977),
    skill: Color(0xFFAD7BF9),
    scrim: Color.fromRGBO(255, 255, 255, .104),
  );

  static CodexThemeData of(BuildContext context) {
    return Theme.of(context).extension<CodexThemeData>() ??
        (Theme.of(context).brightness == Brightness.dark ? dark : light);
  }

  @override
  CodexThemeData copyWith() => this;

  @override
  CodexThemeData lerp(CodexThemeData? other, double t) {
    if (other == null) return this;
    return t < .5 ? this : other;
  }
}
