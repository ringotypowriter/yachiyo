#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

NS = {"w": W_NS, "r": R_NS}


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def collect_text(root: ET.Element) -> str:
    parts: list[str] = []
    for node in root.iter():
        if local_name(node.tag) == "t" and node.text:
            parts.append(node.text)
    return "".join(parts)


def inspect_docx(path: Path) -> dict[str, Any]:
    report: dict[str, Any] = {
        "path": str(path),
        "exists": path.exists(),
        "is_zip": zipfile.is_zipfile(path) if path.exists() else False,
        "paragraph_count": 0,
        "table_count": 0,
        "image_count": 0,
        "header_count": 0,
        "footer_count": 0,
        "comment_count": 0,
        "comment_anchor_count": 0,
        "track_change_count": 0,
        "hyperlink_count": 0,
        "placeholder_tokens": [],
        "sample_text": [],
        "has_numbering": False,
        "has_footnotes": False,
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
        document_name = "word/document.xml"
        if document_name not in names:
            report["notes"].append("word/document.xml is missing.")
            return report

        document_root = ET.fromstring(archive.read(document_name))
        paragraphs = document_root.findall(".//w:p", NS)
        tables = document_root.findall(".//w:tbl", NS)
        hyperlinks = document_root.findall(".//w:hyperlink", NS)

        report["paragraph_count"] = len(paragraphs)
        report["table_count"] = len(tables)
        report["hyperlink_count"] = len(hyperlinks)
        report["image_count"] = len([name for name in names if name.startswith("word/media/")])
        report["header_count"] = len([name for name in names if name.startswith("word/header")])
        report["footer_count"] = len([name for name in names if name.startswith("word/footer")])
        report["comment_anchor_count"] = len(document_root.findall(".//w:commentRangeStart", NS))
        report["track_change_count"] = sum(
            1
            for node in document_root.iter()
            if local_name(node.tag) in {"ins", "del", "moveFrom", "moveTo"}
        )
        report["has_numbering"] = "word/numbering.xml" in names
        report["has_footnotes"] = "word/footnotes.xml" in names

        text_blocks = [collect_text(paragraph).strip() for paragraph in paragraphs]
        report["sample_text"] = [block for block in text_blocks if block][:5]

        placeholders: set[str] = set()
        for block in text_blocks:
            for token in re.findall(r"\{\{[^{}]+\}\}|\$\{[^{}]+\}", block):
                placeholders.add(token)
        report["placeholder_tokens"] = sorted(placeholders)

        if "word/comments.xml" in names:
            comments_root = ET.fromstring(archive.read("word/comments.xml"))
            report["comment_count"] += len(comments_root.findall(".//w:comment", NS))

    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Inspect DOCX structure before editing or generation.")
    parser.add_argument("path", help="Path to the DOCX file")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    report = inspect_docx(Path(args.path))

    if args.json:
        json.dump(report, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    print(f"Path: {report['path']}")
    print(f"Paragraphs: {report['paragraph_count']}")
    print(f"Tables: {report['table_count']}")
    print(f"Images: {report['image_count']}")
    print(f"Placeholders: {', '.join(report['placeholder_tokens']) or 'none'}")
    if report["notes"]:
        print("Notes:")
        for note in report["notes"]:
            print(f"- {note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
