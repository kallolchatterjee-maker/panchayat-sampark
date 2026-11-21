"""Materialise the Panchayat summary sheets of Data/Tracker.xlsx as JSON.

The workbook is deliberately excluded from Git (and from GitHub Pages), so this
is a local maintenance tool: run it after the tracker changes and commit the
generated public/panchayat-summaries.json. Pages reads only that JSON.

Only the Python standard library is used: XLSX is a ZIP of XML parts.
"""

import json
import re
import zipfile
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "Data" / "Tracker.xlsx"
TARGET = ROOT / "public" / "panchayat-summaries.json"
MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS = {"m": MAIN_NS}
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"

MATCHING = [
    ("Gram Panchayat", "gram", "ग्राम पंचायत", "gp"),
    ("Kshetra Panchayat", "kshetra", "क्षेत्र पंचायत", "kp"),
    ("Zila Panchayat", "zila", "ज़िला पंचायत", "zp"),
    ("ULB Data", "ulb", "शहरी निकाय", "ulb"),
]

MATCHING_FIELDS = [
    ("B", "rawRecords"),
    ("C", "uniqueMobiles"),
    ("D", "primaryMembers"),
    ("E", "pmNameMatched"),
    ("F", "pmBoothFilled"),
    ("G", "saralUsers"),
    ("H", "saralNameMatched"),
    ("I", "karyakarta"),
    ("J", "karyakartaNameMatched"),
    ("K", "karyakartaBoothFilled"),
]

BJP_FIELDS = [
    ("E", "taggedCalling"),
    ("F", "taggedPhone"),
    ("G", "taggedArea"),
    ("H", "contested"),
    ("I", "lottery"),
    ("J", "uncontested"),
    ("K", "vacant"),
    ("L", "notMarked"),
]

TIER_LABELS = {"ZP": "ज़िला पंचायत", "KP": "क्षेत्र पंचायत", "GP": "ग्राम पंचायत"}


def shared_strings(archive):
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    return [
        "".join(node.text or "" for node in item.iter(f"{{{MAIN_NS}}}t"))
        for item in root.findall("m:si", NS)
    ]


def cell_value(cell, strings):
    ref = cell.attrib.get("r", "")
    match = re.match(r"([A-Z]+)", ref)
    if not match:
        return "", ""
    column = match.group(1)
    kind = cell.attrib.get("t")
    value = cell.find("m:v", NS)
    inline = cell.find("m:is", NS)
    if kind == "s" and value is not None:
        text = strings[int(value.text)]
    elif kind == "inlineStr" and inline is not None:
        text = "".join(node.text or "" for node in inline.iter(f"{{{MAIN_NS}}}t"))
    elif value is not None:
        text = value.text or ""
    else:
        text = ""
    return column, text.strip()


def sheet_rows(sheet_root, strings):
    rows = {}
    for row in sheet_root.find("m:sheetData", NS):
        number = int(row.attrib.get("r", 0))
        cells = {}
        for cell in row.findall("m:c", NS):
            column, value = cell_value(cell, strings)
            if value:
                cells[column] = value
        rows[number] = cells
    return rows


def number(value):
    if not value or value in {"-", "—", "NaN"}:
        return 0
    try:
        return int(Decimal(value.replace(",", "")))
    except (InvalidOperation, ValueError):
        return 0


def load_sheets():
    with zipfile.ZipFile(SOURCE) as archive:
        strings = shared_strings(archive)
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {item.attrib["Id"]: item.attrib["Target"] for item in rels}
        result = {}
        for sheet in workbook.find("m:sheets", NS):
            name = sheet.attrib.get("name")
            if name not in {
                "Data Matching Summary",
                "Zila_wise_Panchayat_Summary",
                "Panchayat - Data Summary",
                "Prateek",
            }:
                continue
            target = targets[sheet.attrib[REL_NS]].lstrip("/")
            if not target.startswith("xl/"):
                target = "xl/" + target
            result[name] = sheet_rows(ET.fromstring(archive.read(target)), strings)
    return result


def build_matching(rows):
    entries = []
    by_label = {cells.get("A"): cells for cells in rows.values() if cells.get("A")}
    for source, ident, label, short in MATCHING:
        cells = by_label.get(source, {})
        entry = {"id": ident, "label": label, "short": short}
        for column, field in MATCHING_FIELDS:
            entry[field] = number(cells.get(column))
        entries.append(entry)

    totals = {}
    for _, field in MATCHING_FIELDS:
        totals[field] = sum(entry[field] for entry in entries)
    return entries, totals


def build_three_tier(rows):
    total = next((cells for cells in rows.values() if cells.get("A") == "Total"), {})
    return {
        "zila": {
            "units": number(total.get("D")),
            "head": number(total.get("D")),
            "members": number(total.get("F")),
            "contestedHead": number(total.get("E")),
            "contestedMembers": number(total.get("G")),
            "headPhones": number(total.get("P")),
            "memberPhones": number(total.get("R")),
        },
        "kshetra": {
            "units": number(total.get("H")),
            "head": number(total.get("H")),
            "members": number(total.get("J")),
            "contestedHead": number(total.get("I")),
            "contestedMembers": number(total.get("K")),
            "headPhones": number(total.get("T")),
            "memberPhones": number(total.get("V")),
        },
        "gram": {
            "units": number(total.get("L")),
            "head": number(total.get("L")),
            "members": number(total.get("N")),
            "contestedHead": number(total.get("M")),
            "wardMembers": number(total.get("O")),
            "headPhones": number(total.get("X")),
            "memberPhones": number(total.get("Z")),
        },
    }


def build_bjp(rows):
    ordered = sorted(rows)
    primary = []
    tier = ""
    for row_number in ordered:
        cells = rows[row_number]
        designation = cells.get("B", "")
        if cells.get("A", "").startswith(tuple(TIER_LABELS)):
            tier = cells["A"].split("\n", 1)[0]
        if not designation or designation.startswith("Contested"):
            continue
        if not cells.get("C"):
            continue
        primary.append((row_number, tier, designation, cells))

    entries = []
    for index, (row_number, tier, designation, cells) in enumerate(primary):
        next_primary = primary[index + 1][0] if index + 1 < len(primary) else max(ordered) + 1
        overall = next(
            (
                rows[candidate]
                for candidate in range(row_number + 1, next_primary)
                if rows.get(candidate, {}).get("M") == "Overall"
            ),
            {},
        )
        label = "अध्यक्ष" if designation == "Adhyaksh" else "वार्ड सदस्य"
        if tier == "GP" and designation == "Adhyaksh":
            label = "प्रधान"
        entry = {
            "id": f"{tier.lower()}-{'head' if designation == 'Adhyaksh' else 'member'}",
            "tier": TIER_LABELS.get(tier, tier),
            "designation": label,
            "total": number(cells.get("C")),
        }
        for column, field in BJP_FIELDS:
            entry[field] = number(cells.get(column))
        entry["singleBooth"] = number(overall.get("N"))
        entry["multipleBooths"] = number(overall.get("O"))
        entries.append(entry)
    return entries


def build_district_wards(rows):
    entries = []
    for cells in rows.values():
        district = cells.get("A", "")
        if not district or district.lower() == "zila_eng":
            continue
        wards = number(cells.get("B"))
        if wards:
            entries.append({"district": district, "wards": wards})
    entries.sort(key=lambda item: (-item["wards"], item["district"]))
    return entries


def build():
    sheets = load_sheets()
    matching, matching_totals = build_matching(sheets["Data Matching Summary"])
    three_tier = build_three_tier(sheets["Zila_wise_Panchayat_Summary"])
    bjp = build_bjp(sheets["Panchayat - Data Summary"])
    district_wards = build_district_wards(sheets["Prateek"])
    payload = {
        "threeTier": three_tier,
        "dataMatching": matching,
        "dataMatchingTotals": matching_totals,
        "bjp": bjp,
        "districtWards": district_wards,
    }
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(
        f"{TARGET.relative_to(ROOT)}: {len(matching)} local bodies, "
        f"{len(bjp)} designated posts, {len(district_wards)} districts, three-tier heads " +
        ", ".join(str(value["head"]) for value in three_tier.values())
    )


if __name__ == "__main__":
    build()
