#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


def detect_tools() -> dict[str, bool]:
    return {
        "pdfinfo": shutil.which("pdfinfo") is not None,
        "pdftotext": shutil.which("pdftotext") is not None,
        "qpdf": shutil.which("qpdf") is not None,
        "mutool": shutil.which("mutool") is not None,
    }


def run_command(args: list[str]) -> tuple[int, str, str]:
    completed = subprocess.run(args, capture_output=True, text=True)
    return completed.returncode, completed.stdout, completed.stderr


def parse_pdfinfo(text: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        result[key.strip().lower()] = value.strip()
    return result


def fallback_page_count(raw_bytes: bytes) -> int | None:
    matches = re.findall(rb"/Type\s*/Page\b", raw_bytes)
    if not matches:
        return None
    return len(matches)


def inspect_pdf(path: Path) -> dict[str, Any]:
    report: dict[str, Any] = {
        "path": str(path),
        "exists": path.exists(),
        "size_bytes": path.stat().st_size if path.exists() else None,
        "tools": detect_tools(),
        "is_pdf_header": False,
        "page_count": None,
        "title": None,
        "author": None,
        "producer": None,
        "encrypted": None,
        "text_extractable": None,
        "recommended_actions": [],
        "notes": [],
    }

    if not path.exists():
        report["notes"].append("File does not exist.")
        return report

    raw_bytes = path.read_bytes()
    report["is_pdf_header"] = raw_bytes.startswith(b"%PDF-")

    if report["tools"]["pdfinfo"]:
        code, stdout, stderr = run_command(["pdfinfo", str(path)])
        if code == 0:
            parsed = parse_pdfinfo(stdout)
            pages = parsed.get("pages")
            report["page_count"] = int(pages) if pages and pages.isdigit() else None
            report["title"] = parsed.get("title")
            report["author"] = parsed.get("author")
            report["producer"] = parsed.get("producer")
            encrypted = parsed.get("encrypted")
            report["encrypted"] = encrypted.lower().startswith("yes") if encrypted else None
        else:
            report["notes"].append(f"pdfinfo failed: {stderr.strip() or stdout.strip()}")

    if report["page_count"] is None:
        report["page_count"] = fallback_page_count(raw_bytes)

    if report["tools"]["pdftotext"]:
        code, stdout, stderr = run_command(["pdftotext", "-f", "1", "-l", "1", str(path), "-"])
        if code == 0:
            report["text_extractable"] = bool(stdout.strip())
            if stdout.strip():
                report["text_sample"] = stdout.strip()[:280]
        else:
            report["notes"].append(f"pdftotext failed: {stderr.strip() or stdout.strip()}")

    if b"/AcroForm" in raw_bytes:
        report["has_acroform_marker"] = True
        report["recommended_actions"].append("inspect-form-fields")
    else:
        report["has_acroform_marker"] = False

    if report["encrypted"]:
        report["recommended_actions"].append("handle-password-or-permissions")
    elif report["text_extractable"] is False:
        report["recommended_actions"].append("consider-ocr-or-visual-placement")
    else:
        report["recommended_actions"].append("text-or-structural-tools-should-work")

    if not report["is_pdf_header"]:
        report["notes"].append("Header does not start with %PDF-. File may be invalid or wrapped.")

    if report["page_count"] is None:
        report["notes"].append("Could not determine page count with available tooling.")

    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Inspect a PDF and suggest the next reliable route.")
    parser.add_argument("path", help="Path to the PDF file")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    report = inspect_pdf(Path(args.path))

    if args.json:
        json.dump(report, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    print(f"Path: {report['path']}")
    print(f"Exists: {report['exists']}")
    print(f"PDF header: {report['is_pdf_header']}")
    print(f"Page count: {report['page_count']}")
    print(f"Encrypted: {report['encrypted']}")
    print(f"Text extractable: {report['text_extractable']}")
    print(f"Recommended actions: {', '.join(report['recommended_actions']) or 'none'}")

    if report["notes"]:
        print("Notes:")
        for note in report["notes"]:
            print(f"- {note}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
