"""Materialise sheet 3 ('Team Appointment') of Data/Tracker.xlsx as JSON.

The source workbook is deliberately excluded from Git (and from GitHub Pages),
so this script is a local maintenance tool: run it after the tracker changes and
commit the generated public/team-appointments.json.

Only the Python standard library is used: XLSX is a ZIP of XML parts.
"""

import json
import re
import zipfile
import xml.etree.ElementTree as ET
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "Data" / "Tracker.xlsx"
TARGET = ROOT / "public" / "team-appointments.json"
SUMMARY_TARGET = ROOT / "public" / "tracker-summary.json"
MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS = {"m": MAIN_NS}
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


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


def normalise_mobile(value):
    if not value:
        return ""
    try:
        return format(Decimal(value), "f").split(".")[0]
    except Exception:
        return value


def as_text(value):
    return "" if value in {"-", "—", "NaN"} else value


def load_sheet(name):
    with zipfile.ZipFile(SOURCE) as archive:
        strings = shared_strings(archive)
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {item.attrib["Id"]: item.attrib["Target"] for item in rels}
        sheets = list(workbook.find("m:sheets", NS))
        sheet = next(item for item in sheets if item.attrib.get("name") == name)
        target = targets[sheet.attrib[REL_NS]].lstrip("/")
        if not target.startswith("xl/"):
            target = "xl/" + target
        return strings, ET.fromstring(archive.read(target))


def load_rows():
    strings, sheet_root = load_sheet("Team Appointment")

    rows = []
    for row in sheet_root.find("m:sheetData", NS):
        number = int(row.attrib.get("r", 0))
        if number < 4:
            continue
        cells = {}
        for cell in row.findall("m:c", NS):
            column, value = cell_value(cell, strings)
            if value:
                cells[column] = value
        rows.append(cells)
    return rows


def build_summary(rows, totals):
    """Derive the headline numbers from the full Team Appointment sheet.

    The workbook's Summary sheet uses COUNTIFS over $B$4:$B24, a range that was
    never extended as the team grew past 1,200 rows. Its cached values are
    therefore stale (e.g. 5/403 while the team sheet has 1,207 appointments).
    Computing from the same rows that drive the map keeps every number in sync.
    """
    appointed = [row for row in rows if "appoint" in row["status"].lower()]

    def at(level, appointed_only=False):
        source = appointed if appointed_only else rows
        return [row for row in source if row["level"] == level]

    def saral_count(items):
        return sum(1 for row in items if row.get("saral"))

    def entry(target, posts, persons, saral):
        return {
            "target": target,
            "appointed": posts,
            "pending": max(0, target - posts),
            "personsAppointed": persons,
            "enteredSaral": saral,
        }

    zone_rows = at("Zone", True)
    cluster_rows = at("Lok Sabha Cluster Incharge", True)
    pravasi_rows = at("Lok Sabha Pravasi", True)
    vs_rows = at("Vidhan Sabha")
    vs_appointed = at("Vidhan Sabha", True)

    # A Vidhan Sabha team is counted once its संयोजक is appointed; the
    # सह-संयोजक rows are the additional persons in that team.
    vs_teams = {
        row["ac"]
        for row in vs_appointed
        if row["ac"] and row["role"] == "संयोजक"
    }

    zone = entry(6, len(zone_rows), len(zone_rows), saral_count(zone_rows))
    cluster = entry(20, len(cluster_rows), len(cluster_rows), saral_count(cluster_rows))
    pravasi = entry(80, len(pravasi_rows), len(pravasi_rows), saral_count(pravasi_rows))
    vidhan_sabha = entry(403, len(vs_teams), len(vs_appointed), saral_count(vs_appointed))

    total_posts = (
        zone["appointed"]
        + cluster["appointed"]
        + pravasi["appointed"]
        + vidhan_sabha["appointed"]
    )
    total = entry(509, total_posts, totals["appointed"], saral_count(appointed))

    return {
        "zone": zone,
        "cluster": cluster,
        "pravasi": pravasi,
        "vidhanSabha": vidhan_sabha,
        "total": total,
    }


def build():
    raw_rows = load_rows()
    level = zone = zila = ac = ""
    rows = []
    zone_order = []
    for cells in raw_rows:
        if cells.get("B"):
            level = cells["B"]
        if cells.get("C"):
            zone = as_text(cells["C"])
        if cells.get("D"):
            zila = as_text(cells["D"])
        if cells.get("E"):
            ac = as_text(cells["E"])

        name = cells.get("G", "")
        if not name:
            continue
        if level == "Zone" and zone and zone not in zone_order:
            zone_order.append(zone)

        rows.append({
            "level": level,
            "zone": zone,
            "zila": zila,
            "ac": ac,
            "role": cells.get("F", ""),
            "name": name,
            "status": cells.get("H", ""),
            "callingStatus": as_text(cells.get("I", "")),
            "verification": cells.get("J", ""),
            "dutyInfo": as_text(cells.get("K", "")),
            "designation": cells.get("L", ""),
            "mobile": normalise_mobile(cells.get("M", "")),
            "saral": cells.get("N", ""),
        })

    assembly_rows = [row for row in rows if row["level"] == "Vidhan Sabha"]
    appointed = sum(1 for row in rows if "appoint" in row["status"].lower())
    totals = {
        "names": len(rows),
        "appointed": appointed,
        "pending": len(rows) - appointed,
        "zones": sum(1 for row in rows if row["level"] == "Zone"),
        "zoneTarget": 6,
        "zilas": len({row["zila"] for row in assembly_rows if row["zila"]}),
        "acs": len({row["ac"] for row in assembly_rows if row["ac"]}),
        "acsTarget": 403,
        "contacted": sum(1 for row in rows if row["callingStatus"] == "संपर्क हुआ"),
        "verified": sum(1 for row in rows if row["verification"] == "Verified"),
        "notVerified": sum(1 for row in rows if row["verification"] == "Not Verified"),
        "dutyYes": sum(1 for row in rows if row["dutyInfo"] == "हाँ"),
    }

    payload = {"totals": totals, "zoneOrder": zone_order, "rows": rows}
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{TARGET.relative_to(ROOT)}: {len(rows)} rows, {totals['acs']} Vidhan Sabha teams")

    summary = build_summary(rows, totals)
    SUMMARY_TARGET.write_text(
        json.dumps(summary, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(
        f"{SUMMARY_TARGET.relative_to(ROOT)}: "
        f"{summary['vidhanSabha']['appointed']}/{summary['vidhanSabha']['target']} "
        f"Vidhan Sabha, {summary['total']['personsAppointed']} persons appointed"
    )


if __name__ == "__main__":
    build()
