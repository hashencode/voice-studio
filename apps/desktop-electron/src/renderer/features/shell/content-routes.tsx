import * as React from "react";
import { Outlet } from "react-router";

const SectionContentContext = React.createContext<React.ReactNode>(null);

export function SectionContentProvider({
  children,
  content,
}: React.PropsWithChildren<{ content: React.ReactNode }>) {
  return (
    <SectionContentContext.Provider value={content}>
      {children}
    </SectionContentContext.Provider>
  );
}

export function SectionRouteLayout() {
  return <Outlet />;
}

export function SectionRoutePage() {
  return React.useContext(SectionContentContext);
}
