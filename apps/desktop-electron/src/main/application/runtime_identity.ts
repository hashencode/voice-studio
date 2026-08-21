import path from "node:path";

export interface RuntimeIdentityApplication {
  readonly isPackaged: boolean;
  getPath(name: "appData"): string;
  setName(name: string): void;
  setPath(name: "appData" | "userData", value: string): void;
}

const developmentApplicationName = "Voice2Text Development";

export function configureRuntimeIdentity(
  application: RuntimeIdentityApplication,
): void {
  if (application.isPackaged) return;

  const developmentDataRoot = path.join(
    application.getPath("appData"),
    developmentApplicationName,
  );
  application.setName(developmentApplicationName);
  application.setPath("appData", developmentDataRoot);
  application.setPath(
    "userData",
    path.join(developmentDataRoot, "electron-user-data"),
  );
}
