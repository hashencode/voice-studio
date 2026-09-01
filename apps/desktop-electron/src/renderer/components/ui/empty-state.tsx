import type { ReactNode } from "react";
import { Sprout } from "lucide-react";

import { cn } from "@/lib/utils";

export function EmptyState({
  title,
  description,
  actions,
  icon,
  compact = false,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  icon?: ReactNode | false;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "px-4 py-8" : "min-h-72 px-6 py-12",
        className,
      )}
    >
      {icon !== false ? (
        <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon ?? <Sprout className="size-5" aria-hidden="true" />}
        </span>
      ) : null}
      <h3
        className={cn(
          icon === false ? undefined : "mt-3",
          "text-sm font-semibold",
        )}
      >
        {title}
      </h3>
      {description ? (
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      {actions ? <div className="mt-5">{actions}</div> : null}
    </div>
  );
}
