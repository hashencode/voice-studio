export type CaptureLibraryOpenState =
  | { phase: "idle" }
  | { phase: "opening"; intentId: string; audioId: number }
  | {
      phase: "open_failed";
      intentId: string;
      audioId: number;
      message: string;
    };
