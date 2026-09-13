import {
  DesktopFailure,
  type DesktopFailureData,
} from "../../shared/contracts/ipc";
import {
  chooseErrorPresentation,
  type ErrorPresentationContext,
  type ErrorPresentationSurface,
} from "./error-presentation-policy";

export function userFacingError(_cause: unknown, fallback: string): string {
  return fallback;
}

export function desktopFailurePresentation(
  cause: unknown,
  context: ErrorPresentationContext,
): ErrorPresentationSurface | null {
  return cause instanceof DesktopFailure
    ? chooseErrorPresentation(cause.data, context)
    : null;
}

type FailureForDomain<Domain extends DesktopFailureData["domain"]> = Extract<
  DesktopFailureData,
  { domain: Domain }
>;

export function desktopFailureHasCode<
  Domain extends DesktopFailureData["domain"],
>(
  cause: unknown,
  domain: Domain,
  ...codes: readonly FailureForDomain<Domain>["code"][]
): boolean {
  return (
    cause instanceof DesktopFailure &&
    cause.domain === domain &&
    codes.includes(cause.code as FailureForDomain<Domain>["code"])
  );
}
