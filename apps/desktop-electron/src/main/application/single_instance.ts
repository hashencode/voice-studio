export interface SingleInstanceApplication {
  requestSingleInstanceLock(): boolean;
  quit(): void;
}

export function runPrimaryInstance(
  application: SingleInstanceApplication,
  initializePrimary: () => void,
): boolean {
  if (!application.requestSingleInstanceLock()) {
    application.quit();
    return false;
  }
  initializePrimary();
  return true;
}
