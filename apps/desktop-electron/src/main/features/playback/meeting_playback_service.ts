import type {
  MeetingPlaybackSnapshot,
  PlaybackAction,
} from "../../../shared/contracts";

export interface PlaybackMediaResolver {
  resolvePlayback(
    meetingId: number,
  ):
    | { mediaPath: string; durationMs: number }
    | null
    | Promise<{ mediaPath: string; durationMs: number } | null>;
}

export interface MainPlaybackPort {
  open(mediaPath: string): Promise<unknown>;
  play(): Promise<unknown>;
  pause(): Promise<unknown>;
  seek(positionMs: number): Promise<unknown>;
  setSpeed(speed: number): Promise<unknown>;
  close(): Promise<unknown>;
}

export class MeetingPlaybackService {
  private state: MeetingPlaybackSnapshot = {
    meetingId: null,
    initialized: false,
    playing: false,
    positionMs: 0,
    durationMs: 0,
    speed: 1,
    error: null,
  };

  constructor(
    private readonly media: PlaybackMediaResolver,
    private readonly port: MainPlaybackPort,
  ) {}

  snapshot(): MeetingPlaybackSnapshot {
    return { ...this.state };
  }

  async close(): Promise<void> {
    await this.port.close();
    this.state = initialState();
  }

  async command(
    input: { meetingId: number } & PlaybackAction,
  ): Promise<MeetingPlaybackSnapshot> {
    if (input.action === "open") return await this.open(input.meetingId);
    if (!this.state.initialized || this.state.meetingId !== input.meetingId) {
      throw new Error("meeting audio must be opened before playback actions");
    }
    switch (input.action) {
      case "play":
        await this.port.play();
        this.state = { ...this.state, playing: true, error: null };
        break;
      case "pause":
        await this.port.pause();
        this.state = { ...this.state, playing: false, error: null };
        break;
      case "seek": {
        const positionMs = Math.max(
          0,
          Math.min(input.positionMs, this.state.durationMs),
        );
        await this.port.seek(positionMs);
        this.state = { ...this.state, positionMs, error: null };
        break;
      }
      case "speed":
        if (
          !Number.isFinite(input.speed) ||
          input.speed < 0.5 ||
          input.speed > 2
        ) {
          throw new Error("playback speed must be between 0.5 and 2");
        }
        await this.port.setSpeed(input.speed);
        this.state = { ...this.state, speed: input.speed, error: null };
        break;
      case "close":
        await this.close();
        break;
    }
    return this.snapshot();
  }

  private async open(meetingId: number): Promise<MeetingPlaybackSnapshot> {
    const media = await this.media.resolvePlayback(meetingId);
    if (!media) throw new Error("meeting audio is unavailable");
    if (this.state.initialized) await this.port.close();
    try {
      await this.port.open(media.mediaPath);
    } catch (error) {
      await this.close();
      throw error;
    }
    this.state = {
      meetingId,
      initialized: true,
      playing: false,
      positionMs: 0,
      durationMs: media.durationMs,
      speed: 1,
      error: null,
    };
    return this.snapshot();
  }
}

function initialState(): MeetingPlaybackSnapshot {
  return {
    meetingId: null,
    initialized: false,
    playing: false,
    positionMs: 0,
    durationMs: 0,
    speed: 1,
    error: null,
  };
}
