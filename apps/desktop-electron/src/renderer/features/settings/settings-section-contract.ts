export const SETTINGS_SECTION_IDS = {
  general: "settings-general",
  "local-models": "settings-local-models",
  "cloud-models": "settings-cloud-models",
} as const;

export type SettingsSection = keyof typeof SETTINGS_SECTION_IDS;

export function settingsSectionHeadingId(section: SettingsSection): string {
  return `${SETTINGS_SECTION_IDS[section]}-title`;
}

export function isSettingsSection(
  value: string | undefined,
): value is SettingsSection {
  return value !== undefined && value in SETTINGS_SECTION_IDS;
}
