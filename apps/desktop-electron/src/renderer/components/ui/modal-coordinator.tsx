import * as React from "react";

type PendingNavigation = () => void;

interface ModalCoordinatorValue {
  modalCount: number;
  register(token: symbol): void;
  unregister(token: symbol): void;
  requestNavigation(intent: PendingNavigation): void;
}

const ModalCoordinatorContext = React.createContext<ModalCoordinatorValue>({
  modalCount: 0,
  register: () => undefined,
  unregister: () => undefined,
  requestNavigation: (intent) => intent(),
});

export function ModalCoordinatorProvider({
  children,
}: React.PropsWithChildren) {
  const tokensRef = React.useRef(new Set<symbol>());
  const pendingNavigationRef = React.useRef<PendingNavigation | null>(null);
  const [modalCount, setModalCount] = React.useState(0);

  const register = React.useCallback((token: symbol) => {
    if (tokensRef.current.has(token)) return;
    tokensRef.current.add(token);
    setModalCount(tokensRef.current.size);
  }, []);
  const unregister = React.useCallback((token: symbol) => {
    if (!tokensRef.current.delete(token)) return;
    setModalCount(tokensRef.current.size);
  }, []);
  const requestNavigation = React.useCallback((intent: PendingNavigation) => {
    pendingNavigationRef.current = intent;
  }, []);

  React.useEffect(() => {
    if (modalCount !== 0 || !pendingNavigationRef.current) return;
    const intent = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    intent();
  }, [modalCount]);

  const value = React.useMemo(
    () => ({ modalCount, register, unregister, requestNavigation }),
    [modalCount, register, requestNavigation, unregister],
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
