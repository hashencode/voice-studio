import * as React from "react";

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SettingsListBlock,
  SettingsSelectContent,
} from "@/features/settings/settings-page-section";
import { useAppearanceTheme } from "@/features/settings/appearance-theme-provider";
import {
  type AppearanceMode,
  isAppearanceMode,
} from "@/features/settings/appearance-theme";

const APPEARANCE_MODE_LABELS: Record<AppearanceMode, string> = {
  system: "跟随系统",
  dark: "深色",
  light: "浅色",
};

export function AppearanceSettingsFeature() {
  const { mode, setMode } = useAppearanceTheme();

  return (
    <section aria-labelledby="appearance-settings-heading">
      <h2
        id="appearance-settings-heading"
        className="mb-3 text-sm font-medium text-foreground"
      >
        外观
      </h2>
      <SettingsListBlock>
        <Field orientation="horizontal" className="items-center! p-4">
          <FieldContent>
            <FieldLabel id="color-mode-label">色彩模式</FieldLabel>
            <FieldDescription>选择应用界面的明暗外观</FieldDescription>
          </FieldContent>
          <Select
            value={mode}
            onValueChange={(value) => {
              if (isAppearanceMode(value)) setMode(value);
            }}
          >
            <SelectTrigger
              aria-labelledby="color-mode-label"
              className="w-32 shrink-0"
            >
              <SelectValue>{APPEARANCE_MODE_LABELS[mode]}</SelectValue>
            </SelectTrigger>
            <SettingsSelectContent>
              <SelectItem value="system">跟随系统</SelectItem>
              <SelectItem value="dark">深色</SelectItem>
              <SelectItem value="light">浅色</SelectItem>
            </SettingsSelectContent>
          </Select>
        </Field>
      </SettingsListBlock>
    </section>
  );
}
