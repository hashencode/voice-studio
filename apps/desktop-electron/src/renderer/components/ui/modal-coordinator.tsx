import * as React from "react";

type PendingNavigation = () => void;

interface ModalCoordinatorValue {
  modalCount: number;
  applicationBlockerCount: number;
  register(token: symbol): void;
  unregister(token: symbol): void;
  registerApplicationBlocker(token: symbol): void;
  unregisterApplicationBlocker(token: symbol): void;
  requestNavigation(intent: PendingNavigation): void;
}

const ModalCoordinatorContext = React.createContext<ModalCoordinatorValue>({
  modalCount: 0,
  applicationBlockerCount: 0,
  register: () => undefined,
  unregister: () => undefined,
  registerApplicationBlocker: () => undefined,
  unregisterApplicationBlocker: () => undefined,
  requestNavigation: (intent) => intent(),
});

export function ModalCoordinatorProvider({
  children,
}: React.PropsWithChildren) {
  const tokensRef = React.useRef(new Set<symbol>());
  const applicationBlockerTokensRef = React.useRef(new Set<symbol>());
  const pendingNavigationRef = React.useRef<PendingNavigation | null>(null);
  const [modalCount, setModalCount] = React.useState(0);
  const [applicationBlockerCount, setApplicationBlockerCount] =
    React.useState(0);

  const register = React.useCallback((token: symbol) => {
    if (tokensRef.current.has(token)) return;
    tokensRef.current.add(token);
    setModalCount(tokensRef.current.size);
  }, []);
  const unregister = React.useCallback((token: symbol) => {
    if (!tokensRef.current.delete(token)) return;
    setModalCount(tokensRef.current.size);
  }, []);
  const registerApplicationBlocker = React.useCallback((token: symbol) => {
    if (applicationBlockerTokensRef.current.has(token)) return;
    applicationBlockerTokensRef.current.add(token);
    pendingNavigationRef.current = null;
    setApplicationBlockerCount(applicationBlockerTokensRef.current.size);
  }, []);
  const unregisterApplicationBlocker = React.useCallback((token: symbol) => {
    if (!applicationBlockerTokensRef.current.delete(token)) return;
    setApplicationBlockerCount(applicationBlockerTokensRef.current.size);
  }, []);
  const requestNavigation = React.useCallback((intent: PendingNavigation) => {
    if (applicationBlockerTokensRef.current.size > 0) return;
    pendingNavigationRef.current = intent;
  }, []);

  React.useEffect(() => {
    if (
      modalCount !== 0 ||
      applicationBlockerCount !== 0 ||
      !pendingNavigationRef.current
    )
      return;
    const intent = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    intent();
  }, [applicationBlockerCount, modalCount]);

  const value = React.useMemo(
    () => ({
      modalCount,
      applicationBlockerCount,
      register,
      unregister,
      registerApplicationBlocker,
      unregisterApplicationBlocker,
      requestNavigation,
    }),
    [
      applicationBlockerCount,
      modalCount,
      register,
      registerApplicationBlocker,
      requestNavigation,
      unregister,
      unregisterApplicationBlocker,
    ],
  );
  return (
    <ModalCoordinatorContext.Provider value={value}>
      {children}
    </ModalCoordinatorContext.Provider>
  );
}

export function useModalCoordinator() {
  const coordinator = React.useContext(ModalCoordinatorContext);
  return {
    modalCount: coordinator.modalCount,
    modalOpen: coordinator.modalCount > 0,
    applicationBlocked: coordinator.applicationBlockerCount > 0,
    requestNavigationAfterModals: coordinator.requestNavigation,
  };
}

export function useModalRegistration(open: boolean): void {
  const { register, unregister } = React.useContext(ModalCoordinatorContext);
  const tokenRef = React.useRef<symbol | null>(null);
  if (tokenRef.current === null) tokenRef.current = Symbol("modal");
  React.useEffect(() => {
    const token = tokenRef.current!;
    if (!open) return;
    register(token);
    return () => unregister(token);
  }, [open, register, unregister]);
}

export function useApplicationBlockerRegistration(open: boolean): void {
  const { registerApplicationBlocker, unregisterApplicationBlocker } =
    React.useContext(ModalCoordinatorContext);
  const tokenRef = React.useRef<symbol | null>(null);
  if (tokenRef.current === null)
    tokenRef.current = Symbol("application-blocker");
  React.useEffect(() => {
    const token = tokenRef.current!;
    if (!open) return;
    registerApplicationBlocker(token);
    return () => unregisterApplicationBlocker(token);
  }, [open, registerApplicationBlocker, unregisterApplicationBlocker]);
}
