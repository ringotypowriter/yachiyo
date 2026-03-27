#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

FIELD_NAME_RE = re.compile(rb"/T\s*\((.*?)\)")
FIELD_TYPE_RE = re.compile(rb"/FT\s*/([A-Za-z]+)")


def inspect_form_fields(path: Path) -> dict[str, Any]:
    report: dict[str, Any] = {
        "path": str(path),
        "exists": path.exists(),
        "has_acroform_marker": False,
        "field_count": 0,
        "field_names": [],
        "field_types": [],
        "notes": [],
    }

    if not path.exists():
        report["notes"].append("File does not exist.")
        return report

    raw_bytes = path.read_bytes()
    report["has_acroform_marker"] = b"/AcroForm" in raw_bytes

    field_names = sorted(
        {
            match.decode("latin-1", errors="replace")
            for match in FIELD_NAME_RE.findall(raw_bytes)
            if match.strip()
        }
    )
    field_types = sorted(
        {
            match.decode("ascii", errors="replace")
            for match in FIELD_TYPE_RE.findall(raw_bytes)
            if match.strip()
        }
    )

    report["field_names"] = field_names
    report["field_types"] = field_types
    report["field_count"] = len(field_names)

    if report["has_acroform_marker"] and not field_names:
        report["notes"].append(
            "AcroForm marker exists, but raw field names were not found. Use a richer PDF form tool if needed."
        )
    if not report["has_acroform_marker"]:
        report["notes"].append("No AcroForm marker found. The PDF may be a flat form.")

    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="List likely PDF AcroForm field names from raw bytes.")
    parser.add_argument("path", help="Path to the PDF file")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    report = inspect_form_fields(Path(args.path))

    if args.json:
        json.dump(report, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    print(f"Path: {report['path']}")
    print(f"Has AcroForm marker: {report['has_acroform_marker']}")
    print(f"Field count: {report['field_count']}")
    if report["field_names"]:
        print("Field names:")
        for name in report["field_names"]:
            print(f"- {name}")
    if report["notes"]:
        print("Notes:")
        for note in report["notes"]:
            print(f"- {note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
