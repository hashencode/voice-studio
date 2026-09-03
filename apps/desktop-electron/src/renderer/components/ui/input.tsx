import * as React from "react";

import { cn } from "@/lib/utils";

function Input({
  className,
  type,
  variant = "default",
  ...props
}: React.ComponentProps<"input"> & {
  variant?: "default" | "context-search";
}) {
  return (
    <input
      type={type}
      data-slot="input"
      data-variant={variant}
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground read-only:cursor-default read-only:bg-muted/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm dark:bg-input/30 dark:read-only:bg-muted/20 dark:disabled:bg-input/80",
        "focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/40",
        "aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        variant === "context-search" &&
          "h-7 rounded-[10px] bg-background pl-7 text-xs leading-4 md:text-xs",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
