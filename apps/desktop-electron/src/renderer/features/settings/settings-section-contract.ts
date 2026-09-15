import {
  settingsSectionSchema,
  type SettingsSection,
} from "../../../shared/contracts";

export const SETTINGS_SECTION_IDS = {
  general: "settings-general",
  recording: "settings-recording",
  "local-models": "settings-local-models",
  "cloud-models": "settings-cloud-models",
} as const satisfies Record<SettingsSection, string>;

export type { SettingsSection };

export function isSettingsSection(
  value: string | undefined,
): value is SettingsSection {
  return settingsSectionSchema.safeParse(value).success;
}
