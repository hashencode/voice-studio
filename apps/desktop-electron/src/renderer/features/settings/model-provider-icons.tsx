import { Cloud } from "lucide-react";

const deepSeekIconUrl = new URL(
  "../../../../assets/model-providers/deepseek.svg",
  import.meta.url,
).href;

export function ModelProviderIcon({
  protocol,
}: {
  protocol: "deepseek" | "openai-compatible";
}) {
  if (protocol === "deepseek") {
    return (
      <img alt="" aria-hidden="true" className="size-5" src={deepSeekIconUrl} />
    );
  }
  return <Cloud aria-hidden="true" className="size-5" />;
}
