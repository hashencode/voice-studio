import type * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApplicationBlockerRegistration } from "@/components/ui/modal-coordinator";

export function ApplicationBlocker({
  open,
  title,
  description,
  children,
}: React.PropsWithChildren<{
  open: boolean;
  title: React.ReactNode;
  description: React.ReactNode;
}>) {
  useApplicationBlockerRegistration(open);

  return (
    <Dialog open={open} onOpenChange={() => undefined}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
