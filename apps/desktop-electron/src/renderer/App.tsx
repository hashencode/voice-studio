import { useState } from "react";
import { CheckCircle2, LoaderCircle, ShieldCheck } from "lucide-react";

import { AppSidebar } from "@/components/app-sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

type HealthState = "idle" | "checking" | "healthy" | "failed";

export default function App() {
  const [health, setHealth] = useState<HealthState>("idle");
  const [detail, setDetail] = useState("尚未检查打包 worker");

  const checkWorker = async () => {
    setHealth("checking");
    setDetail("正在通过受限 Preload API 请求 Main 启动 worker…");
    try {
      const result = await window.voice2text.workerHealth();
      setHealth("healthy");
      setDetail(`${result.protocol} · ${result.workerSha256.slice(0, 12)}…`);
    } catch (error) {
      setHealth("failed");
      setDetail(error instanceof Error ? error.message : "worker 健康检查失败");
    }
  };

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>会议库</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <main className="flex flex-1 flex-col gap-6 p-6">
          <section className="rounded-xl border bg-card p-6 shadow-sm">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">
                  Electron macOS feasibility
                </p>
                <h1 className="text-2xl font-semibold tracking-tight">
                  本地会议工作台
                </h1>
                <p className="max-w-2xl text-sm text-muted-foreground">
                  Renderer 保持 sandbox；所有进程与资源访问只通过 Main
                  中的固定、版本化接口。
                </p>
              </div>
              <Button onClick={checkWorker} disabled={health === "checking"}>
                {health === "checking" ? (
                  <LoaderCircle className="animate-spin" />
                ) : health === "healthy" ? (
                  <CheckCircle2 />
                ) : (
                  <ShieldCheck />
                )}
                检查本地 worker
              </Button>
            </div>
            <div
              className="mt-6 rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {detail}
            </div>
          </section>
          <section className="grid gap-4 md:grid-cols-3">
            {[
              ["会议", "导入或录制后的会议将在这里显示"],
              ["转写任务", "运行中、可恢复和已完成任务"],
              ["Companion", "配对与局域网传输状态"],
            ].map(([title, description]) => (
              <article key={title} className="rounded-xl border bg-card p-5">
                <h2 className="font-medium">{title}</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {description}
                </p>
              </article>
            ))}
          </section>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
