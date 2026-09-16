import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

function ThreeCubesIllustration() {
  return (
    <div
      data-slot="empty-state-graphic"
      aria-hidden="true"
      className="relative isolate h-32 w-[13.5rem]"
    >
      <svg viewBox="0 0 220 140" fill="none" className="h-full w-full">
        <line
          x1="40"
          y1="0"
          x2="40"
          y2="140"
          stroke="currentColor"
          strokeOpacity="0.05"
          strokeWidth="0.5"
        />
        <line
          x1="110"
          y1="0"
          x2="110"
          y2="140"
          stroke="currentColor"
          strokeOpacity="0.05"
          strokeWidth="0.5"
        />
        <line
          x1="180"
          y1="0"
          x2="180"
          y2="140"
          stroke="currentColor"
          strokeOpacity="0.05"
          strokeWidth="0.5"
        />
        <line
          x1="0"
          y1="25"
          x2="220"
          y2="25"
          stroke="currentColor"
          strokeOpacity="0.05"
          strokeWidth="0.5"
        />
        <line
          x1="0"
          y1="70"
          x2="220"
          y2="70"
          stroke="currentColor"
          strokeOpacity="0.05"
          strokeWidth="0.5"
        />
        <line
          x1="0"
          y1="115"
          x2="220"
          y2="115"
          stroke="currentColor"
          strokeOpacity="0.05"
          strokeWidth="0.5"
        />
        <polygon
          data-slot="empty-state-cube"
          points="89,58 110,70 110,94 89,106 68,94 68,70"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.28"
          strokeWidth="0.75"
          strokeLinejoin="round"
        />
        <line
          x1="89"
          y1="82"
          x2="68"
          y2="70"
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="0.5"
        />
        <line
          x1="89"
          y1="82"
          x2="110"
          y2="70"
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="0.5"
        />
        <line
          x1="89"
          y1="82"
          x2="89"
          y2="106"
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="0.5"
        />
        <polygon
          data-slot="empty-state-cube"
          points="110,46 131,58 131,82 110,94 89,82 89,58"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.38"
          strokeWidth="0.75"
          strokeLinejoin="round"
        />
        <line
          x1="110"
          y1="70"
          x2="89"
          y2="58"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="0.5"
        />
        <line
          x1="110"
          y1="70"
          x2="131"
          y2="58"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="0.5"
        />
        <line
          x1="110"
          y1="70"
          x2="110"
          y2="94"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="0.5"
        />
        <polygon
          data-slot="empty-state-cube"
          points="131,34 152,46 152,70 131,82 110,70 110,46"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.5"
          strokeWidth="0.75"
          strokeLinejoin="round"
        />
        <line
          x1="131"
          y1="58"
          x2="110"
          y2="46"
          stroke="currentColor"
          strokeOpacity="0.35"
          strokeWidth="0.5"
        />
        <line
          x1="131"
          y1="58"
          x2="152"
          y2="46"
          stroke="currentColor"
          strokeOpacity="0.35"
          strokeWidth="0.5"
        />
        <line
          x1="131"
          y1="58"
          x2="131"
          y2="82"
          stroke="currentColor"
          strokeOpacity="0.35"
          strokeWidth="0.5"
        />
        <path
          d="M148 22 L155 26 L148 30 L141 26 Z"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="0.5"
          strokeDasharray="2 2"
        />
        <circle cx="40" cy="70" r="1.5" fill="currentColor" opacity="0.1" />
        <circle cx="180" cy="70" r="1.5" fill="currentColor" opacity="0.1" />
        <circle cx="110" cy="25" r="1.5" fill="currentColor" opacity="0.07" />
      </svg>
    </div>
  );
}

export function EmptyState({
  description,
  compact = false,
  className,
}: {
  description: string;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "px-4 py-8" : "min-h-72 px-6 py-12",
        className,
      )}
    >
      <ThreeCubesIllustration />
      <p className="mt-3 max-w-md text-sm text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

export function FullScreenEmptyState({
  icon,
  title,
  description,
  actions,
  feedback,
  busy = false,
  className,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  feedback?: ReactNode;
  busy?: boolean;
  className?: string;
}) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <section
      data-slot="full-screen-empty-state"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy || undefined}
      className={cn(
        "@container/empty-state relative mx-auto flex min-h-0 w-full flex-1 items-center justify-center",
        className,
      )}
    >
      <div
        data-slot="full-screen-empty-state-layout"
        className="mx-auto grid min-h-[440px] w-full max-w-4xl min-w-0 grid-cols-1 items-center @min-[48rem]/empty-state:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      >
        <div
          data-slot="full-screen-empty-state-content"
          className="flex min-w-0 items-center px-7 py-8 sm:px-9 sm:py-10 @min-[48rem]/empty-state:pr-5"
        >
          <div className="flex w-full min-w-0 flex-1 flex-col items-start justify-center gap-6 p-6 text-left text-balance">
            <div className="flex max-w-md flex-col items-start gap-4 text-left">
              <span
                data-slot="full-screen-empty-state-icon"
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center self-start rounded-[10px] bg-muted text-foreground [&_svg]:size-4"
              >
                {icon}
              </span>
              <div className="flex flex-col gap-2">
                <h2
                  data-slot="full-screen-empty-state-title"
                  id={titleId}
                  className="text-xl leading-7 font-semibold tracking-tight sm:text-2xl sm:leading-8"
                >
                  {title}
                </h2>
                {description ? (
                  <p
                    data-slot="full-screen-empty-state-description"
                    id={descriptionId}
                    className="max-w-md text-sm leading-5 text-muted-foreground"
                  >
                    {description}
                  </p>
                ) : null}
              </div>
            </div>
            {actions ? (
              <div
                data-slot="full-screen-empty-state-actions"
                className="flex w-full min-w-0 flex-wrap items-center gap-2"
              >
                {actions}
              </div>
            ) : null}
            {feedback ? (
              <div
                data-slot="full-screen-empty-state-feedback"
                className="min-w-0 space-y-2"
              >
                {feedback}
              </div>
            ) : null}
          </div>
        </div>
        <div
          data-slot="full-screen-empty-state-preview"
          aria-hidden="true"
          className="flex min-w-0 items-end bg-muted/10 px-7 pt-2 sm:px-9 @min-[48rem]/empty-state:absolute @min-[48rem]/empty-state:top-[calc(50%-146px)] @min-[48rem]/empty-state:right-0 @min-[48rem]/empty-state:bottom-0 @min-[48rem]/empty-state:left-[calc(50%+10px)] @min-[48rem]/empty-state:p-0"
        >
          <div
            data-slot="full-screen-empty-state-preview-surface"
            className="min-h-[350px] w-full overflow-hidden rounded-t-xl border-t border-x border-border/60 bg-background sm:min-h-[360px] @min-[48rem]/empty-state:h-full @min-[48rem]/empty-state:min-h-0 @min-[48rem]/empty-state:rounded-tl-xl @min-[48rem]/empty-state:rounded-tr-none @min-[48rem]/empty-state:border-r-0"
          />
        </div>
      </div>
    </section>
  );
}
