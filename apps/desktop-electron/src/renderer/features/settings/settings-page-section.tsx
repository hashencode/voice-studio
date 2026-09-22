import * as React from "react";

import { ItemGroup } from "@/components/ui/item";
import { SelectContent } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { SettingsSection } from "@/features/settings/settings-section-contract";

const SettingsPageSelectionContext =
  React.createContext<SettingsSection | null>(null);

export function SettingsPageSelectionProvider({
  value,
  children,
}: React.PropsWithChildren<{ value: SettingsSection }>) {
  return (
    <SettingsPageSelectionContext.Provider value={value}>
      {children}
    </SettingsPageSelectionContext.Provider>
  );
}

export function SettingsPageSection({
  section,
  label,
  action,
  children,
  className,
}: React.PropsWithChildren<{
  section: SettingsSection;
  label: string;
  action?: React.ReactNode;
  className?: string;
}>) {
  const selectedSection = React.useContext(SettingsPageSelectionContext);
  const hasAction = action !== undefined;
  return (
    <section
      data-settings-section={section}
      aria-label={label}
      hidden={selectedSection !== null && selectedSection !== section}
      className={className}
    >
      {hasAction ? (
        <div className="flex min-h-8 justify-end">
          <div className="shrink-0">{action}</div>
        </div>
      ) : null}
      <div
        className={hasAction ? "mt-(--spacing-settings-section)" : undefined}
      >
        {children}
      </div>
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
        "gap-0 overflow-hidden rounded-xl border bg-card shadow-none [&_[data-slot=item-description]]:line-clamp-1 [&_[data-slot=item-description]]:text-xs [&_[data-slot=item-description]]:leading-4 [&_[data-slot=item-separator]]:my-0 [&_[data-slot=item-title]]:text-sm [&_[data-slot=item-title]]:leading-5",
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

export function SettingsSelectContent({
  position = "popper",
  align = "end",
  ...props
}: React.ComponentProps<typeof SelectContent>) {
  return <SelectContent position={position} align={align} {...props} />;
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
