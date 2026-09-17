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
  initialFocusRef,
  children,
}: React.PropsWithChildren<{
  open: boolean;
  title: React.ReactNode;
  description: React.ReactNode;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}>) {
  useApplicationBlockerRegistration(open);

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          if (!initialFocusRef?.current) return;
          event.preventDefault();
          initialFocusRef.current.focus();
        }}
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
