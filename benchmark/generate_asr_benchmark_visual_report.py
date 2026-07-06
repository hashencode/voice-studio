#!/usr/bin/env python3
"""Generate a standalone visual report for ASR benchmark results."""

from __future__ import annotations

import html
import argparse
import json
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RESULT_DIR = ROOT / "build" / "asr_benchmark" / "results"
MANIFEST_FILE = ROOT / "benchmark" / "asr_benchmark_manifest.json"
SUMMARY_FILE = ROOT / "benchmark" / "asr_benchmark_summary_2026-07-05.json"
REPORT_FILE = ROOT / "benchmark" / "asr_benchmark_visual_report_2026-07-05.html"

TOKENS = {
    "surface": "#FCFCFD",
    "panel": "#FFFFFF",
    "ink": "#1F2430",
    "muted": "#6F768A",
    "grid": "#E6E8F0",
    "axis": "#D7DBE7",
    "green": "#A3D576",
    "green_dark": "#386411",
    "blue": "#A3BEFA",
    "blue_dark": "#2E4780",
    "orange": "#F0986E",
    "orange_dark": "#804126",
}

MODEL_LABELS = {
    "paraformer-zh-2025-10-07": "Paraformer zh int8",
    "paraformer-en-2024-03-09": "Paraformer en",
}

ROUTE_LABELS = {
    "standard": "标准线路",
    "realtime_replay": "实时 replay",
}

RUN_CLASS_LABELS = {
    "warm": "warm",
    "cold": "cold",
    "current": "current",
}


@dataclass(frozen=True)
class ResultRow:
    report_file: str
    schema_version: int
    route: str
    profile_id: str
    profile_name: str
    run_class: str
    load_strategy: str
    mode: str
    model_id: str
    label: str
    language: str
    duration_sec: float
    segment_count: int
    non_empty_segments: int
    recognizer_load_ms: int
    total_recognizer_load_ms: int
    recognizer_load_count: int
    warmup_wall_ms: int
    decode_wall_ms: int
    operation_wall_ms: int
    rtf: float
    operation_rtf: float
    metric: str
    error_rate: float
    native_heap_after_mb: float
    p95_segment_decode_ms: int
    profile: dict[str, object]

    def to_json(self) -> dict[str, object]:
        return self.__dict__


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def pct(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value * 100:.2f}%"


def seconds(ms: int | float | None) -> str:
    if ms is None:
        return "n/a"
    return f"{ms / 1000:.3f}s"


def mib(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.1f}MiB"


def lang_label(language: str) -> str:
    return "中文" if language == "zh" else "英文"


def report_sequence(path_name: str) -> int:
    stem = path_name.removeprefix("asr-benchmark-").removesuffix(".json")
    return int(stem) if stem.isdigit() else 0


def load_active_manifest_ids() -> tuple[set[str], set[str]]:
    manifest = json.loads(MANIFEST_FILE.read_text())
    model_ids = {item["id"] for item in manifest["models"]}
    audio_case_ids = {item["id"] for item in manifest["audioCases"]}
    return model_ids, audio_case_ids


def route_for_legacy(mode: str) -> str:
    return "standard"


def profile_description(row: ResultRow) -> str:
    profile = row.profile
    if row.route == "realtime_replay":
        vad_type = str(profile.get("vadType", row.mode))
        if vad_type == "rms":
            return (
                f"RMS threshold {profile.get('speechThreshold', 'n/a')}, "
                f"end {profile.get('endSilenceMs', 'n/a')}ms, "
                f"max {profile.get('maxSegmentMs', 'n/a')}ms, "
                f"pre-roll {profile.get('preRollMs', 0)}ms"
            )
        vad = profile.get("vad") if isinstance(profile.get("vad"), dict) else {}
        return (
            f"Silero threshold {vad.get('threshold', 'n/a')}, "
            f"silence {vad.get('minSilenceDurationSec', 'n/a')}s, "
            f"max {vad.get('maxSpeechDurationSec', 'n/a')}s"
        )
    return f"{row.mode}, threads {profile.get('numThreads', 'n/a')}"


def load_rows(
    active_model_ids: set[str],
    active_audio_case_ids: set[str],
    result_files: list[Path] | None = None,
) -> list[ResultRow]:
    if not RESULT_DIR.is_dir():
        raise SystemExit(f"Missing benchmark result directory: {RESULT_DIR}")

    rows: list[ResultRow] = []
    paths = result_files or sorted(RESULT_DIR.glob("asr-benchmark-*.json"))
    for path in sorted(paths):
        data = json.loads(path.read_text())
        schema_version = int(data.get("schemaVersion", 1))
        window_ms = int(data.get("segmentWindowMs", 12000))
        for item in data.get("results", []):
            if item["modelId"] not in active_model_ids:
                continue
            if item["audioCaseId"] not in active_audio_case_ids:
                continue

            mode = item.get("mode", "")
            route = item.get("route", route_for_legacy(mode))
            profile_id = item.get("profileId") or f"legacy-{mode}-{item['modelId']}-{item['audioCaseId']}"
            profile_name = item.get("profileName") or mode
            profile = item.get("profile") if isinstance(item.get("profile"), dict) else {"mode": mode, "numThreads": item.get("profileNumThreads", "legacy")}
            segment_count = int(item.get("segmentCount", 1))
            non_empty = int(item.get("nonEmptySegmentCount", 0))
            if non_empty == 0:
                segments = item.get("segments", [])
                non_empty = sum(1 for segment in segments if not segment.get("emptyResult")) if segments else (0 if item.get("emptyResult") else 1)
            decode_wall_ms = int(item.get("decodeWallMs", 0))
            total_load_ms = int(item.get("totalRecognizerLoadMs", 0))
            operation_wall_ms = int(item.get("operationWallMs", decode_wall_ms + total_load_ms))
            duration_sec = float(item.get("durationSec", 0.0))
            rtf = float(item.get("rtf", decode_wall_ms / 1000.0 / duration_sec if duration_sec else 0.0))
            operation_rtf = float(item.get("operationRtf", operation_wall_ms / 1000.0 / duration_sec if duration_sec else rtf))
            rows.append(
                ResultRow(
                    report_file=path.name,
                    schema_version=schema_version,
                    route=route,
                    profile_id=profile_id,
                    profile_name=profile_name,
                    run_class=item.get("runClass", "warm"),
                    load_strategy=item.get("loadStrategy", "shared"),
                    mode=mode,
                    model_id=item["modelId"],
                    label=MODEL_LABELS.get(item["modelId"], item["modelId"]),
                    language=item["audioCaseId"],
                    duration_sec=duration_sec,
                    segment_count=segment_count,
                    non_empty_segments=non_empty,
                    recognizer_load_ms=int(item.get("recognizerLoadMs", 0)),
                    total_recognizer_load_ms=total_load_ms,
                    recognizer_load_count=int(item.get("recognizerLoadCount", 0)),
                    warmup_wall_ms=int(item.get("warmupWallMs", 0)),
                    decode_wall_ms=decode_wall_ms,
                    operation_wall_ms=operation_wall_ms,
                    rtf=rtf,
                    operation_rtf=operation_rtf,
                    metric=item.get("accuracyMetric", ""),
                    error_rate=float(item.get("errorRate", 0.0)),
                    native_heap_after_mb=float(item.get("nativeHeapAfterBytes", 0)) / 1024 / 1024,
                    p95_segment_decode_ms=int(item.get("p95SegmentDecodeWallMs", 0)),
                    profile=profile,
                ),
            )

    if not rows:
        source = ", ".join(str(path) for path in paths) if paths else str(RESULT_DIR)
        raise SystemExit(f"No benchmark JSON results found for: {source}")
    profile_rows = [row for row in rows if row.schema_version >= 2 or not row.profile_id.startswith("legacy-")]
    return profile_rows or rows


def latest_by_profile(rows: list[ResultRow]) -> list[ResultRow]:
    selected: dict[tuple[str, str, str, str], ResultRow] = {}
    for row in rows:
        key = (row.route, row.profile_id, row.model_id, row.language)
        current = selected.get(key)
        if current is None or report_sequence(row.report_file) > report_sequence(current.report_file):
            selected[key] = row
    return list(selected.values())


def sorted_rows(rows: list[ResultRow]) -> list[ResultRow]:
    class_order = {"warm": 0, "current": 1, "cold": 2}
    return sorted(rows, key=lambda row: (class_order.get(row.run_class, 9), row.language, row.error_rate, row.operation_rtf))


def best_text(rows: list[ResultRow], route: str, language: str) -> str:
    scoped = [row for row in rows if row.route == route and row.language == language and row.run_class == "warm"]
    if not scoped:
        scoped = [row for row in rows if row.route == route and row.language == language]
    if not scoped:
        return "n/a"
    row = min(scoped, key=lambda item: (item.error_rate, item.operation_rtf))
    return f"{row.profile_name}：{row.metric.upper()} {pct(row.error_rate)}"


def bar_chart(rows: list[ResultRow], title: str, subtitle: str, value_attr: str, value_label) -> str:
    width = 920
    label_width = 310
    plot_width = width - label_width - 130
    row_h = 40
    top = 72
    bottom = 30
    height = top + bottom + max(1, len(rows)) * row_h
    values = [float(getattr(row, value_attr)) for row in rows]
    max_value = (max(values) if values else 1.0) or 1.0
    max_v = max_value * 1.15
    lines = [
        f'<svg class="chart-svg" viewBox="0 0 {width} {height}" role="img" aria-label="{esc(title)}">',
        f'<text class="chart-title" x="0" y="18">{esc(title)}</text>',
        f'<text class="chart-subtitle" x="0" y="42">{esc(subtitle)}</text>',
    ]
    for fraction in (0.25, 0.5, 0.75, 1.0):
        x = label_width + plot_width * fraction
        lines.append(f'<line class="grid" x1="{x:.1f}" y1="{top - 10}" x2="{x:.1f}" y2="{height - bottom + 4}" />')
    for index, row in enumerate(rows):
        y = top + index * row_h
        raw = float(getattr(row, value_attr))
        bar_w = plot_width * raw / max_v if max_v else 0
        fill = TOKENS["green"] if row.run_class == "warm" else TOKENS["blue"] if row.run_class == "current" else TOKENS["orange"]
        stroke = TOKENS["green_dark"] if row.run_class == "warm" else TOKENS["blue_dark"] if row.run_class == "current" else TOKENS["orange_dark"]
        lines.extend(
            [
                f'<text class="axis-label" x="0" y="{y + 16}">{esc(row.profile_name)}</text>',
                f'<text class="axis-hint" x="0" y="{y + 31}">{esc(lang_label(row.language))} · {esc(row.run_class)} · {esc(row.load_strategy)}</text>',
                f'<rect class="bar" x="{label_width}" y="{y + 3}" width="{max(1, bar_w):.1f}" height="18" fill="{fill}" stroke="{stroke}" />',
                f'<text class="value-label" x="{label_width + bar_w + 8:.1f}" y="{y + 18}">{esc(value_label(raw))}</text>',
            ],
        )
    lines.append("</svg>")
    return "\n".join(lines)


def profile_table(rows: list[ResultRow]) -> str:
    if not rows:
        return '<p class="empty">还没有这个线路的结果。运行对应 profile 后重新生成报告即可。</p>'
    body = []
    for row in sorted_rows(rows):
        body.append(
            "<tr>"
            f"<td><strong>{esc(row.profile_name)}</strong><br><span>{esc(profile_description(row))}</span></td>"
            f"<td>{esc(lang_label(row.language))}</td>"
            f"<td>{esc(RUN_CLASS_LABELS.get(row.run_class, row.run_class))}</td>"
            f"<td>{esc(row.load_strategy)}</td>"
            f"<td>{row.metric.upper()} {pct(row.error_rate)}</td>"
            f"<td>{row.rtf:.4f}</td>"
            f"<td>{row.operation_rtf:.4f}</td>"
            f"<td>{seconds(row.decode_wall_ms)}</td>"
            f"<td>{seconds(row.total_recognizer_load_ms)}</td>"
            f"<td>{row.segment_count}/{row.non_empty_segments}</td>"
            f"<td>{row.p95_segment_decode_ms}ms</td>"
            f"<td>{mib(row.native_heap_after_mb)}</td>"
            "</tr>",
        )
    return (
        '<div class="table-wrap"><table class="detail-table">'
        "<thead><tr><th>Profile</th><th>语言</th><th>类别</th><th>加载策略</th><th>错误率</th><th>Decode RTF</th><th>Operation RTF</th><th>解码</th><th>加载</th><th>分段/非空</th><th>p95段解码</th><th>Native heap</th></tr></thead>"
        f"<tbody>{''.join(body)}</tbody></table></div>"
    )


def tab_panel(route: str, rows: list[ResultRow]) -> str:
    route_rows = [row for row in rows if row.route == route]
    warm_rows = [row for row in route_rows if row.run_class == "warm"] or route_rows
    return f"""
      <section class="tab-panel" id="panel-{esc(route)}">
        <h2>{esc(ROUTE_LABELS.get(route, route))}</h2>
        <div class="grid-two">
          <div class="chart">{bar_chart(sorted_rows(warm_rows), "准确率", "越低越好；warm 行用于主要排序。", "error_rate", pct) if route_rows else '<p class="empty">暂无结果</p>'}</div>
          <div class="chart">{bar_chart(sorted_rows(warm_rows), "Operation RTF", "包含当前 profile 记录到的模型加载成本。", "operation_rtf", lambda value: f"{value:.4f}") if route_rows else '<p class="empty">暂无结果</p>'}</div>
        </div>
        <h2>Profile 明细</h2>
        {profile_table(route_rows)}
      </section>
    """


def write_summary(rows: list[ResultRow], sources: list[Path] | None) -> None:
    payload = {
        "generatedFrom": [str(path.relative_to(ROOT) if path.is_relative_to(ROOT) else path) for path in sources]
        if sources
        else str(RESULT_DIR.relative_to(ROOT)),
        "comparisonUnit": "parameter_profile",
        "routes": {
            "standard": [row.to_json() for row in sorted_rows([item for item in rows if item.route == "standard"])],
            "realtime_replay": [row.to_json() for row in sorted_rows([item for item in rows if item.route == "realtime_replay"])],
        },
        "allResults": [row.to_json() for row in rows],
    }
    SUMMARY_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def render_report(rows: list[ResultRow]) -> str:
    style = f"""
    <style>
      :root {{
        --surface: {TOKENS['surface']};
        --panel: {TOKENS['panel']};
        --ink: {TOKENS['ink']};
        --muted: {TOKENS['muted']};
        --grid: {TOKENS['grid']};
        --axis: {TOKENS['axis']};
      }}
      * {{ box-sizing: border-box; }}
      body {{ margin: 0; background: var(--surface); color: var(--ink); font-family: Inter, "Segoe UI", Arial, sans-serif; line-height: 1.45; }}
      main {{ width: min(1180px, calc(100vw - 32px)); margin: 28px auto 60px; }}
      h1 {{ margin: 0 0 8px; font-size: clamp(28px, 4vw, 42px); letter-spacing: 0; }}
      h2 {{ margin: 26px 0 12px; font-size: 22px; letter-spacing: 0; }}
      p {{ color: var(--muted); max-width: 920px; }}
      .kpis {{ display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 20px 0 22px; }}
      .kpi {{ background: var(--panel); border: 1px solid var(--axis); border-radius: 8px; padding: 14px 16px; }}
      .kpi strong {{ display: block; font-size: 18px; margin-bottom: 4px; }}
      .kpi span {{ color: var(--muted); font-size: 13px; }}
      .tabs {{ display: flex; gap: 8px; margin: 18px 0 12px; border-bottom: 1px solid var(--axis); }}
      .tab-input {{ position: absolute; opacity: 0; pointer-events: none; }}
      .tab-label {{ border: 1px solid var(--axis); border-bottom: 0; border-radius: 8px 8px 0 0; padding: 10px 14px; background: #F4F5F7; cursor: pointer; font-weight: 650; }}
      #tab-standard:checked ~ .tabs label[for="tab-standard"],
      #tab-realtime:checked ~ .tabs label[for="tab-realtime"] {{ background: var(--panel); color: var(--ink); }}
      .tab-panel {{ display: none; }}
      #tab-standard:checked ~ #panel-standard,
      #tab-realtime:checked ~ #panel-realtime_replay {{ display: block; }}
      .grid-two {{ display: grid; grid-template-columns: 1fr; gap: 18px; align-items: start; }}
      .chart {{ background: var(--panel); border: 1px solid var(--axis); border-radius: 8px; padding: 18px; overflow: hidden; }}
      .chart-svg {{ width: 100%; max-width: 100%; height: auto; display: block; }}
      .chart-title {{ font-weight: 700; font-size: 18px; fill: var(--ink); }}
      .chart-subtitle {{ font-size: 12px; fill: var(--muted); }}
      .axis-label {{ font-size: 12px; fill: var(--ink); font-weight: 650; }}
      .axis-hint {{ font-size: 10px; fill: var(--muted); }}
      .value-label {{ font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 11px; fill: var(--ink); }}
      .grid {{ stroke: var(--grid); stroke-width: 1; }}
      .bar {{ stroke-width: 1; }}
      .table-wrap {{ max-width: 100%; overflow-x: auto; border: 1px solid var(--axis); border-radius: 8px; background: var(--panel); }}
      .detail-table {{ width: 100%; min-width: 1080px; border-collapse: collapse; background: var(--panel); }}
      .detail-table th, .detail-table td {{ padding: 10px 12px; border-bottom: 1px solid var(--grid); text-align: left; font-size: 13px; vertical-align: top; }}
      .detail-table th {{ color: var(--muted); font-weight: 650; background: #F4F5F7; }}
      .detail-table td:nth-child(n+5) {{ font-family: "SF Mono", Menlo, Consolas, monospace; }}
      .detail-table span {{ color: var(--muted); font-size: 12px; }}
      .empty {{ background: var(--panel); border: 1px solid var(--axis); border-radius: 8px; padding: 18px; }}
      @media (max-width: 900px) {{ .kpis, .grid-two {{ grid-template-columns: 1fr; }} main {{ width: min(100vw - 20px, 1180px); }} }}
    </style>
    """
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ASR Paraformer Parameter Benchmark</title>
  {style}
</head>
<body>
<main>
  <header>
    <h1>Paraformer 参数 benchmark</h1>
    <p>模型固定为 Paraformer，比较单位改为参数 profile。warm steady-state 用于主排序，cold/current 单独展示，避免把模型加载成本和参数效果混在一起。</p>
  </header>

  <section class="kpis">
    <div class="kpi"><strong>标准中文</strong><span>{esc(best_text(rows, "standard", "zh"))}</span></div>
    <div class="kpi"><strong>标准英文</strong><span>{esc(best_text(rows, "standard", "en"))}</span></div>
    <div class="kpi"><strong>实时中文</strong><span>{esc(best_text(rows, "realtime_replay", "zh"))}</span></div>
    <div class="kpi"><strong>实时英文</strong><span>{esc(best_text(rows, "realtime_replay", "en"))}</span></div>
  </section>

  <input class="tab-input" type="radio" name="route-tabs" id="tab-standard" checked />
  <input class="tab-input" type="radio" name="route-tabs" id="tab-realtime" />
  <nav class="tabs">
    <label class="tab-label" for="tab-standard">标准线路 benchmark</label>
    <label class="tab-label" for="tab-realtime">实时线路 replay benchmark</label>
  </nav>

  {tab_panel("standard", rows)}
  {tab_panel("realtime_replay", rows)}
</main>
</body>
</html>
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--result-file",
        action="append",
        type=Path,
        help="Generate the report from one result JSON file. Can be repeated.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result_files = [path.resolve() for path in args.result_file] if args.result_file else None
    if result_files:
        missing = [str(path) for path in result_files if not path.is_file()]
        if missing:
            raise SystemExit(f"Missing result file(s): {', '.join(missing)}")
    active_model_ids, active_audio_case_ids = load_active_manifest_ids()
    rows = latest_by_profile(load_rows(active_model_ids, active_audio_case_ids, result_files))
    write_summary(rows, result_files)
    REPORT_FILE.write_text(render_report(rows))
    print(f"Wrote {SUMMARY_FILE}")
    print(f"Wrote {REPORT_FILE}")


if __name__ == "__main__":
    main()
