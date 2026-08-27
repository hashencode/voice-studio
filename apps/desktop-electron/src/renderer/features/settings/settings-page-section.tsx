import * as React from "react";

import { ItemGroup } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  settingsSectionHeadingId,
  type SettingsSection,
} from "@/features/settings/settings-section-contract";

export function SettingsPageSection({
  section,
  title,
  children,
  className,
}: React.PropsWithChildren<{
  section: SettingsSection;
  title: string;
  className?: string;
}>) {
  const headingId = settingsSectionHeadingId(section);
  return (
    <section
      data-settings-section={section}
      aria-labelledby={headingId}
      className={cn("scroll-mt-6", className)}
    >
      <h2
        id={headingId}
        tabIndex={-1}
        className="text-base leading-[22px] font-medium outline-none"
      >
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function SettingsItemGroup({
  className,
  ...props
}: React.ComponentProps<typeof ItemGroup>) {
  return (
    <ItemGroup
      className={cn(
        "gap-0 overflow-hidden rounded-xl border bg-card [&_[data-slot=item-description]]:line-clamp-1 [&_[data-slot=item-separator]]:my-0",
        className,
      )}
      {...props}
    />
  );
}

export function SettingsListBlock({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card shadow-none [&_[data-slot=field-description]]:text-xs [&_[data-slot=field-description]]:leading-4 [&_[data-slot=field-label]]:text-sm [&_[data-slot=field-label]]:leading-5",
        className,
      )}
      {...props}
    />
  );
}

export function SettingsListSkeleton({ rows = 1 }: { rows?: number }) {
  return (
    <SettingsListBlock role="status" aria-label="正在读取设置">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={cn(
            "flex min-h-16 items-center justify-between gap-4 p-4",
            index > 0 && "border-t",
          )}
        >
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-[22px] w-40 max-w-full" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
          <Skeleton className="h-8 w-20 shrink-0" />
        </div>
      ))}
    </SettingsListBlock>
  );
}
