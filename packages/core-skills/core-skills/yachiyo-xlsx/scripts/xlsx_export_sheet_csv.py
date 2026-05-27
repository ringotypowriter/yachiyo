#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import json
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

NS = {"main": MAIN_NS, "r": REL_NS, "pr": PACKAGE_REL_NS}


def column_index(cell_ref: str) -> int:
    letters = "".join(ch for ch in cell_ref if ch.isalpha()).upper()
    total = 0
    for char in letters:
        total = total * 26 + ord(char) - ord("A") + 1
    return max(total - 1, 0)


def load_shared_strings(archive: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    values: list[str] = []
    for item in root.findall(".//main:si", NS):
        text = "".join(node.text or "" for node in item.findall(".//main:t", NS))
        values.append(text)
    return values


def resolve_sheet_target(archive: zipfile.ZipFile, sheet_name: str | None) -> tuple[str, str]:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    sheets = workbook.findall(".//main:sheets/main:sheet", NS)
    if not sheets:
        raise ValueError("Workbook has no sheets.")

    selected = None
    if sheet_name is None:
        selected = sheets[0]
    else:
        for sheet in sheets:
            if sheet.attrib.get("name") == sheet_name:
                selected = sheet
                break
    if selected is None:
        raise ValueError(f"Sheet not found: {sheet_name}")

    rel_id = selected.attrib.get(f"{{{REL_NS}}}id")
    if rel_id is None:
        raise ValueError("Selected sheet is missing relationship id.")

    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    for rel in rels.findall(".//pr:Relationship", NS):
        if rel.attrib.get("Id") == rel_id:
            target = rel.attrib.get("Target")
            if not target:
                break
            normalized_target = target.lstrip("/")
            if not normalized_target.startswith("xl/"):
                normalized_target = f"xl/{normalized_target}"
            return selected.attrib.get("name", "Sheet1"), normalized_target

    raise ValueError(f"Could not resolve worksheet target for relationship id: {rel_id}")


def cell_value(cell: ET.Element, shared_strings: list[str]) -> str:
    cell_type = cell.attrib.get("t")
    formula = cell.find("main:f", NS)
    value = cell.find("main:v", NS)
    inline = cell.find("main:is", NS)

    if inline is not None:
        return "".join(node.text or "" for node in inline.findall(".//main:t", NS))
    if cell_type == "s" and value is not None and value.text is not None:
        index = int(value.text)
        return shared_strings[index] if 0 <= index < len(shared_strings) else ""
    if formula is not None and value is not None and value.text is not None:
        return value.text
    if value is not None and value.text is not None:
        return value.text
    return ""


def export_sheet(input_path: Path, output_path: Path, sheet_name: str | None) -> dict[str, Any]:
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")
    if not zipfile.is_zipfile(input_path):
        raise ValueError(f"Input is not a valid XLSX container: {input_path}")

    with zipfile.ZipFile(input_path) as archive:
        selected_name, worksheet_path = resolve_sheet_target(archive, sheet_name)
        shared_strings = load_shared_strings(archive)
        worksheet = ET.fromstring(archive.read(worksheet_path))

        rows_out: list[list[str]] = []
        for row in worksheet.findall(".//main:sheetData/main:row", NS):
            cells = row.findall("main:c", NS)
            if not cells:
                rows_out.append([])
                continue
            max_index = max(column_index(cell.attrib.get("r", "A1")) for cell in cells)
            row_values = [""] * (max_index + 1)
            for cell in cells:
                index = column_index(cell.attrib.get("r", "A1"))
                row_values[index] = cell_value(cell, shared_strings)
            rows_out.append(row_values)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerows(rows_out)

    return {
        "input_path": str(input_path),
        "output_path": str(output_path),
        "sheet_name": selected_name,
        "row_count": len(rows_out),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Export one XLSX sheet to CSV using only the package XML.")
    parser.add_argument("input", help="Input XLSX path")
    parser.add_argument("output", help="Output CSV path")
    parser.add_argument("--sheet", dest="sheet_name", help="Sheet name to export. Defaults to first sheet.")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    report = export_sheet(Path(args.input), Path(args.output), args.sheet_name)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
