import path from "node:path";

import type { ResourceDownload } from "./resource-download-cache";

export interface FrozenDownload {
  id: string;
  source: string;
  sha256: string;
  bytes: number;
  kind: "file" | "tar.bz2";
}

export interface ResourcePlanAuthority {
  downloads: FrozenDownload[];
}

export interface ResourcePlanSenseVoiceAuthority {
  model: { source: string; archiveSha256: string };
  vad: { source: string; sha256: string };
}

export interface ResourcePlanSenseVoiceLock {
  archiveBytes: number;
  vadBytes: number;
}

export interface PlannedResourceDownload extends ResourceDownload {
  id: string;
}

export const runtimeArchive = {
  id: "sherpa-onnx-macos-runtime",
  package: "sherpa_onnx_macos",
  version: "1.13.4",
  source: "https://pub.dev/api/archives/sherpa_onnx_macos-1.13.4.tar.gz",
  sha256: "55164fa38db3de870dc834b855be6b6b5cc0acb7663d74cea76c3de4e7bd7a47",
  bytes: 20_190_460,
};

export function resourceDownloadPlan(input: {
  authority: ResourcePlanAuthority;
  senseVoiceAuthority: ResourcePlanSenseVoiceAuthority;
  senseVoiceLock: ResourcePlanSenseVoiceLock;
  temporaryRoot: string;
  liveCaptionOnly: boolean;
  runtime?: Pick<typeof runtimeArchive, "source" | "sha256" | "bytes">;
}): PlannedResourceDownload[] {
  const selectedRuntime = input.runtime ?? runtimeArchive;
  const downloads: PlannedResourceDownload[] = [];
  if (!input.liveCaptionOnly) {
    downloads.push(
      ...input.authority.downloads.map((download) => ({
        id: download.id,
        source: download.source,
        sha256: download.sha256,
        bytes: download.bytes,
        stagingPath: path.join(input.temporaryRoot, `${download.id}.download`),
      })),
      {
        id: runtimeArchive.id,
        source: selectedRuntime.source,
        sha256: selectedRuntime.sha256,
        bytes: selectedRuntime.bytes,
        stagingPath: path.join(input.temporaryRoot, "runtime.tar.gz"),
      },
    );
  }
  downloads.push(
    {
      id: "sensevoice-model-archive",
      source: input.senseVoiceAuthority.model.source,
      sha256: input.senseVoiceAuthority.model.archiveSha256,
      bytes: input.senseVoiceLock.archiveBytes,
      stagingPath: path.join(input.temporaryRoot, "sensevoice-model.download"),
    },
    {
      id: "sensevoice-silero-vad",
      source: input.senseVoiceAuthority.vad.source,
      sha256: input.senseVoiceAuthority.vad.sha256,
      bytes: input.senseVoiceLock.vadBytes,
      stagingPath: path.join(input.temporaryRoot, "sensevoice-vad.download"),
    },
  );
  return downloads;
}
