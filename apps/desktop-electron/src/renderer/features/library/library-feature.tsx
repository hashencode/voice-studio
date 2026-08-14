import type { ApplicationSnapshot } from "@shared/contracts";

import { LibrarySurface } from "@/features/shell/shell-surfaces";

export function LibraryFeature({
  state,
  writable,
  importPending,
  onImport,
}: {
  state: ApplicationSnapshot["library"];
  writable: boolean;
  importPending: boolean;
  onImport: () => void | Promise<void>;
}) {
  return (
    <LibrarySurface
      state={state}
      writable={writable}
      importPending={importPending}
      onImport={() => void onImport()}
    />
  );
}
