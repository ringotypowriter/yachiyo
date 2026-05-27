#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"

NS = {"a": A_NS, "p": P_NS}


def collect_shape_text(root: ET.Element) -> list[str]:
    blocks: list[str] = []
    for shape in root.findall(".//p:sp", NS):
        text_runs = [node.text for node in shape.findall(".//a:t", NS) if node.text]
        text = "".join(text_runs).strip()
        if text:
            blocks.append(text)
    return blocks


def inspect_pptx(path: Path) -> dict[str, Any]:
    report: dict[str, Any] = {
        "path": str(path),
        "exists": path.exists(),
        "is_zip": zipfile.is_zipfile(path) if path.exists() else False,
        "slide_count": 0,
        "slides": [],
        "image_count": 0,
        "chart_count": 0,
        "notes_slide_count": 0,
        "layout_count": 0,
        "notes": [],
    }

    if not path.exists():
        report["notes"].append("File does not exist.")
        return report
    if not report["is_zip"]:
        report["notes"].append("File is not a valid ZIP container.")
        return report

    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        presentation_name = "ppt/presentation.xml"
        if presentation_name not in names:
            report["notes"].append("ppt/presentation.xml is missing.")
            return report

        presentation_root = ET.fromstring(archive.read(presentation_name))
        slide_ids = presentation_root.findall(".//p:sldIdLst/p:sldId", NS)
        report["slide_count"] = len(slide_ids)
        report["image_count"] = len([name for name in names if name.startswith("ppt/media/")])
        report["chart_count"] = len([name for name in names if name.startswith("ppt/charts/")])
        report["notes_slide_count"] = len([name for name in names if name.startswith("ppt/notesSlides/")])
        report["layout_count"] = len([name for name in names if name.startswith("ppt/slideLayouts/")])

        for index in range(1, report["slide_count"] + 1):
            slide_name = f"ppt/slides/slide{index}.xml"
            slide_report: dict[str, Any] = {
                "index": index,
                "xml_path": slide_name,
                "title": None,
                "text_blocks": [],
                "shape_count": 0,
                "table_count": 0,
            }
            if slide_name in names:
                slide_root = ET.fromstring(archive.read(slide_name))
                blocks = collect_shape_text(slide_root)
                slide_report["text_blocks"] = blocks[:5]
                slide_report["title"] = blocks[0] if blocks else None
                slide_report["shape_count"] = len(slide_root.findall(".//p:sp", NS))
                slide_report["table_count"] = len(slide_root.findall(".//a:tbl", NS))
            else:
                slide_report["missing"] = True
            report["slides"].append(slide_report)

    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Inspect PPTX structure before editing or generation.")
    parser.add_argument("path", help="Path to the PPTX file")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    report = inspect_pptx(Path(args.path))

    if args.json:
        json.dump(report, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    print(f"Path: {report['path']}")
    print(f"Slides: {report['slide_count']}")
    print(f"Charts: {report['chart_count']}")
    print(f"Images: {report['image_count']}")
    if report["notes"]:
        print("Notes:")
        for note in report["notes"]:
            print(f"- {note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
