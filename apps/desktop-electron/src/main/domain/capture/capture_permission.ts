export interface MicrophonePermissionAuthority {
  getMediaAccessStatus(mediaType: "microphone"): string;
  askForMediaAccess(mediaType: "microphone"): Promise<boolean>;
}

export async function requestMicrophonePermissionIfNeeded(
  authority: MicrophonePermissionAuthority,
): Promise<void> {
  if (authority.getMediaAccessStatus("microphone") !== "not-determined") {
    return;
  }
  await authority.askForMediaAccess("microphone");
}
