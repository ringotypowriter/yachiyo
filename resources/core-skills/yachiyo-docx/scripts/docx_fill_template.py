#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

TARGET_XML_RE = re.compile(r"^word/(document|header\d+|footer\d+)\.xml$")


def replace_placeholders(xml_bytes: bytes, mapping: dict[str, str]) -> tuple[bytes, int]:
    root = ET.fromstring(xml_bytes)
    replaced = 0

    for node in root.iter():
        if node.tag == f"{{{W_NS}}}t" and node.text:
            original = node.text
            updated = original
            for key, value in mapping.items():
                updated = updated.replace(key, value)
            if updated != original:
                node.text = updated
                replaced += 1

    return ET.tostring(root, encoding="utf-8", xml_declaration=True), replaced


def fill_template(input_path: Path, output_path: Path, mapping: dict[str, str]) -> dict[str, object]:
    report: dict[str, object] = {
        "input_path": str(input_path),
        "output_path": str(output_path),
        "exists": input_path.exists(),
        "replaced_text_nodes": 0,
        "updated_parts": [],
    }

    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")
    if not zipfile.is_zipfile(input_path):
        raise ValueError(f"Input is not a valid DOCX container: {input_path}")

    with tempfile.TemporaryDirectory(prefix="yachiyo-docx-fill-") as tmp_dir:
        temp_output = Path(tmp_dir) / output_path.name
        with zipfile.ZipFile(input_path) as source, zipfile.ZipFile(
            temp_output, "w", compression=zipfile.ZIP_DEFLATED
        ) as target:
            for info in source.infolist():
                payload = source.read(info.filename)
                if TARGET_XML_RE.match(info.filename):
                    payload, count = replace_placeholders(payload, mapping)
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
    parser = argparse.ArgumentParser(description="Fill simple placeholder tokens inside a DOCX.")
    parser.add_argument("input", help="Input DOCX path")
    parser.add_argument("output", help="Output DOCX path")
    parser.add_argument(
        "--map",
        dest="mapping_path",
        required=True,
        help="JSON file containing placeholder -> replacement mapping",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    mapping = json.loads(Path(args.mapping_path).read_text(encoding="utf-8"))

    if not isinstance(mapping, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in mapping.items()
    ):
        raise ValueError("Mapping file must be a JSON object of string keys and string values.")

    report = fill_template(Path(args.input), Path(args.output), mapping)
    json.dump(report, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
