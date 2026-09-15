export const CAPTURE_LIBRARY_RECEIPT_KIND = "capture-library";
export const CAPTURE_LIBRARY_RECEIPT_PREFIX = `${CAPTURE_LIBRARY_RECEIPT_KIND}:`;

export function captureLibraryReceiptKey(sessionId: string): string {
  return `${CAPTURE_LIBRARY_RECEIPT_PREFIX}${sessionId}`;
}
