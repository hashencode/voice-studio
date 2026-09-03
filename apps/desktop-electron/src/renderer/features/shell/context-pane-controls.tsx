import type * as React from "react";
import { Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ContextPaneSearch(props: React.ComponentProps<typeof Input>) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input {...props} type="search" variant="context-search" />
    </div>
  );
}

export function ContextPaneFilter({
  label,
  count,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children"> & {
  label: string;
  count: number;
}) {
  return (
    <Button {...props} type="button" variant="filter" size="filter">
      {label} <Badge variant="filter-count">{count}</Badge>
    </Button>
  );
}
