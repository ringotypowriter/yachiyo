#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

NS = {"main": MAIN_NS, "rel": REL_NS}


def inspect_xlsx(path: Path) -> dict[str, Any]:
    report: dict[str, Any] = {
        "path": str(path),
        "exists": path.exists(),
        "is_zip": zipfile.is_zipfile(path) if path.exists() else False,
        "sheet_count": 0,
        "sheets": [],
        "defined_name_count": 0,
        "table_count": 0,
        "chart_count": 0,
        "drawing_count": 0,
        "external_link_count": 0,
        "has_macros": False,
        "has_calc_chain": False,
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
        workbook_name = "xl/workbook.xml"
        if workbook_name not in names:
            report["notes"].append("xl/workbook.xml is missing.")
            return report

        workbook_root = ET.fromstring(archive.read(workbook_name))
        sheets = workbook_root.findall(".//main:sheets/main:sheet", NS)
        report["sheet_count"] = len(sheets)
        report["defined_name_count"] = len(workbook_root.findall(".//main:definedNames/main:definedName", NS))
        report["table_count"] = len([name for name in names if name.startswith("xl/tables/")])
        report["chart_count"] = len([name for name in names if name.startswith("xl/charts/")])
        report["drawing_count"] = len([name for name in names if name.startswith("xl/drawings/")])
        report["external_link_count"] = len([name for name in names if name.startswith("xl/externalLinks/")])
        report["has_macros"] = "xl/vbaProject.bin" in names
        report["has_calc_chain"] = "xl/calcChain.xml" in names

        for index, sheet in enumerate(sheets, start=1):
            sheet_name = sheet.attrib.get("name", f"Sheet{index}")
            worksheet_name = f"xl/worksheets/sheet{index}.xml"
            sheet_report: dict[str, Any] = {
                "name": sheet_name,
                "xml_path": worksheet_name,
                "dimension": None,
                "formula_count": 0,
                "merged_range_count": 0,
                "table_part_count": 0,
                "data_validation_count": 0,
                "row_count_hint": 0,
            }
            if worksheet_name in names:
                worksheet_root = ET.fromstring(archive.read(worksheet_name))
                dimension = worksheet_root.find(".//main:dimension", NS)
                formulas = worksheet_root.findall(".//main:f", NS)
                merges = worksheet_root.findall(".//main:mergeCells/main:mergeCell", NS)
                table_parts = worksheet_root.findall(".//main:tableParts/main:tablePart", NS)
                data_validations = worksheet_root.findall(
                    ".//main:dataValidations/main:dataValidation", NS
                )
                rows = worksheet_root.findall(".//main:sheetData/main:row", NS)

                sheet_report["dimension"] = dimension.attrib.get("ref") if dimension is not None else None
                sheet_report["formula_count"] = len(formulas)
                sheet_report["merged_range_count"] = len(merges)
                sheet_report["table_part_count"] = len(table_parts)
                sheet_report["data_validation_count"] = len(data_validations)
                sheet_report["row_count_hint"] = len(rows)
            else:
                sheet_report["missing"] = True
            report["sheets"].append(sheet_report)

    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Inspect XLSX structure before editing or delivery.")
    parser.add_argument("path", help="Path to the XLSX file")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    report = inspect_xlsx(Path(args.path))

    if args.json:
        json.dump(report, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    print(f"Path: {report['path']}")
    print(f"Sheets: {report['sheet_count']}")
    print(f"Charts: {report['chart_count']}")
    print(f"Tables: {report['table_count']}")
    print(f"Macros: {report['has_macros']}")
    if report["notes"]:
        print("Notes:")
        for note in report["notes"]:
            print(f"- {note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
