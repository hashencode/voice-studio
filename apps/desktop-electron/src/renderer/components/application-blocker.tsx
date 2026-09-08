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
  onDismiss,
  children,
}: React.PropsWithChildren<{
  open: boolean;
  title: React.ReactNode;
  description: React.ReactNode;
  onDismiss?: () => void;
}>) {
  useApplicationBlockerRegistration(open);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onDismiss?.();
      }}
    >
      <DialogContent
        showCloseButton={Boolean(onDismiss)}
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
