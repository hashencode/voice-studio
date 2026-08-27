import { Cloud } from "lucide-react";

const deepSeekIconUrl = new URL(
  "../../../../assets/model-providers/deepseek.svg",
  import.meta.url,
).href;

export function ModelProviderIcon({
  protocol,
  active = false,
}: {
  protocol: "deepseek" | "openai-compatible";
  active?: boolean;
}) {
  if (protocol === "deepseek") {
    return (
      <img
        alt=""
        aria-hidden="true"
        className={active ? "size-5" : "size-5 grayscale opacity-50"}
        src={deepSeekIconUrl}
      />
    );
  }
  return (
    <Cloud
      aria-hidden="true"
      className={
        active ? "size-5 text-primary" : "size-5 text-muted-foreground"
      }
    />
  );
}
