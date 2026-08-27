export const microphonePrivacySettingsUri =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
export const privacyAndSecuritySettingsUri =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension";

export async function openMicrophoneSettings(
  openExternal: (uri: string) => Promise<void>,
): Promise<{ state: "opened" | "failed" }> {
  try {
    await openExternal(microphonePrivacySettingsUri);
    return { state: "opened" };
  } catch {
    try {
      await openExternal(privacyAndSecuritySettingsUri);
      return { state: "opened" };
    } catch {
      return { state: "failed" };
    }
  }
}
