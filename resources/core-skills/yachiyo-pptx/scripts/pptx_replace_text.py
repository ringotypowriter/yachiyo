#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"


def replace_text(xml_bytes: bytes, target_text: str, replacement_text: str) -> tuple[bytes, int]:
    root = ET.fromstring(xml_bytes)
    replaced = 0
    for node in root.iter():
        if node.tag == f"{{{A_NS}}}t" and node.text and target_text in node.text:
            node.text = node.text.replace(target_text, replacement_text)
            replaced += 1
    return ET.tostring(root, encoding="utf-8", xml_declaration=True), replaced


def replace_in_deck(
    input_path: Path, output_path: Path, target_text: str, replacement_text: str
) -> dict[str, object]:
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")
    if not zipfile.is_zipfile(input_path):
        raise ValueError(f"Input is not a valid PPTX container: {input_path}")

    report: dict[str, object] = {
        "input_path": str(input_path),
        "output_path": str(output_path),
        "target_text": target_text,
        "replacement_text": replacement_text,
        "replaced_text_nodes": 0,
        "updated_parts": [],
    }

    with tempfile.TemporaryDirectory(prefix="yachiyo-pptx-replace-") as tmp_dir:
        temp_output = Path(tmp_dir) / output_path.name
        with zipfile.ZipFile(input_path) as source, zipfile.ZipFile(
            temp_output, "w", compression=zipfile.ZIP_DEFLATED
        ) as target:
            for info in source.infolist():
                payload = source.read(info.filename)
                if info.filename.startswith("ppt/slides/slide") and info.filename.endswith(".xml"):
                    payload, count = replace_text(payload, target_text, replacement_text)
                    if count > 0:
                        report["replaced_text_nodes"] = int(report["replaced_text_nodes"]) + count
                        cast_parts = report["updated_parts"]
                        assert isinstance(cast_parts, list)
                        cast_parts.append(info.filename)
                target.writestr(info, payload)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(temp_output, output_path)

    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Replace exact text inside PPTX slide text nodes.")
    parser.add_argument("input", help="Input PPTX path")
    parser.add_argument("output", help="Output PPTX path")
    parser.add_argument("--from", dest="from_text", required=True, help="Target text to replace")
    parser.add_argument("--to", dest="to_text", required=True, help="Replacement text")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    report = replace_in_deck(Path(args.input), Path(args.output), args.from_text, args.to_text)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
