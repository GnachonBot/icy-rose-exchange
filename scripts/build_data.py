#!/usr/bin/env python3
"""Convert the Icy Rose Excel workbook to static price data for GitHub Pages.

Only uses the Python standard library; no install required.

Usage:
    python scripts/build_data.py source/prices.xlsx site/data/prices.json

Pricing rules:
  - Craftable item sell: your manually entered Items & Prices F price,
    otherwise 2 x recipe material cost (Items & Prices E as backup).
  - Craftable item buy: Buying Calculator O fixed price override, then N
    per-item buy percentage, otherwise Buying Calculator P3 default (50%).
  - Material sell: Materials & Prices J override, otherwise C.
    Pawn Shop L overrides any shop selling price if entered.
  - Material buy: Materials & Prices F exact entered price (including zero).
"""

from __future__ import annotations
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

M = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
P = "http://schemas.openxmlformats.org/package/2006/relationships"


def load_workbook(path: Path) -> dict[str, dict[str, str | float | bool]]:
    """Read displayed literal/cached Excel values by cell without external deps."""
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            sroot = ET.fromstring(z.read("xl/sharedStrings.xml"))
            shared = ["".join(t.text or "" for t in si.iter(f"{{{M}}}t"))
                      for si in sroot.findall(f"{{{M}}}si")]
        root = ET.fromstring(z.read("xl/workbook.xml"))
        relationships = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        rel_map = {r.attrib["Id"]: r.attrib["Target"] for r in relationships}
        sheets = {}
        for info in root.findall(f".//{{{M}}}sheet"):
            name = info.attrib["name"]
            target = rel_map[info.attrib[f"{{{R}}}id"]].lstrip("/")
            if not target.startswith("xl/"):
                target = "xl/" + target
            if target not in z.namelist():
                raise ValueError(f"Excel sheet {name} not found in ZIP ({target}).")
            cells = {}
            for cell in ET.fromstring(z.read(target)).iter(f"{{{M}}}c"):
                coordinate = cell.attrib.get("r")
                if not coordinate:
                    continue
                value_el = cell.find(f"{{{M}}}v")
                if cell.attrib.get("t") == "inlineStr":
                    inline = cell.find(f"{{{M}}}is")
                    value = "".join(t.text or "" for t in inline.iter(f"{{{M}}}t")) if inline is not None else ""
                elif value_el is None or value_el.text is None:
                    continue
                else:
                    raw = value_el.text
                    cell_type = cell.attrib.get("t")
                    if cell_type == "s":
                        value = shared[int(raw)]
                    elif cell_type in ("str", "e"):
                        value = raw
                    elif cell_type == "b":
                        value = raw == "1"
                    else:
                        try:
                            value = float(raw)
                        except (TypeError, ValueError):
                            value = raw
                cells[coordinate] = value
            sheets[name] = cells
        return sheets


def number(value):
    if isinstance(value, bool) or value in (None, ""):
        return None
    if isinstance(value, (float, int)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.replace(",", "").strip())
        except ValueError:
            return None
    return None


def tidy(value):
    return str(value or "").strip()


def normalize_price(value):
    if value is None:
        return None
    return round(float(value), 2)


def make_data(source: Path):
    sheets = load_workbook(source)
    for must_have in ("Materials & Prices", "Items & Prices", "Buying Calculator"):
        if must_have not in sheets:
            raise ValueError(f"Workbook is missing required tab: {must_have}")

    materials_ws = sheets["Materials & Prices"]
    items_ws = sheets["Items & Prices"]
    buying_ws = sheets["Buying Calculator"]
    pawn_ws = sheets.get("Pawn Shop", {})
    recipes_ws = sheets.get("Recipe Ingredients", {})
    cash_ws = sheets.get("Cash Calculator", {})

    materials = []
    material_costs = {}
    for r in range(7, 1000):
        name = tidy(materials_ws.get(f"A{r}"))
        if not name:
            continue
        base_sell = number(materials_ws.get(f"C{r}"))
        own_sell = number(materials_ws.get(f"J{r}"))
        sell = own_sell if own_sell is not None else base_sell
        buy = number(materials_ws.get(f"F{r}"))
        material_costs[name.casefold()] = base_sell
        materials.append({
            "id": f"material:{name.casefold()}",
            "name": name,
            "group": "Materials",
            "type": "material",
            "craftCost": None,
            "sellPrice": normalize_price(sell),
            "buyPrice": normalize_price(buy),
            "priceSource": "custom" if own_sell is not None else "material",
            "buySource": "material fixed" if buy is not None else "not set"
        })

    # Recipe costs can be calculated directly from ingredient quantities, so a
    # newly uploaded workbook needn't have been recalculated in Excel first.
    ingredients = defaultdict(list)
    for r in range(7, 2000):
        item_id = tidy(recipes_ws.get(f"A{r}"))
        material = tidy(recipes_ws.get(f"D{r}"))
        quantity = number(recipes_ws.get(f"E{r}"))
        if item_id and material and quantity is not None:
            ingredients[item_id].append((material, quantity))

    # Source data for shop sell overrides & item purchase offer overrides.
    shop_override = {}
    for r in range(11, 2000):
        name = tidy(pawn_ws.get(f"J{r}"))
        override = number(pawn_ws.get(f"L{r}"))
        if name and override is not None:
            shop_override[name.casefold()] = override

    buy_overrides = {}
    for r in range(11, 2000):
        name = tidy(buying_ws.get(f"L{r}"))
        if not name:
            continue
        fixed = number(buying_ws.get(f"O{r}"))
        pct = number(buying_ws.get(f"N{r}"))
        if fixed is not None or pct is not None:
            buy_overrides[name.casefold()] = (fixed, pct)
    default_buy_pct = number(buying_ws.get("P3"))
    if default_buy_pct is None:
        default_buy_pct = 0.5

    items = []
    for r in range(7, 1000):
        name = tidy(items_ws.get(f"C{r}"))
        if not name:
            continue
        item_id = tidy(items_ws.get(f"A{r}")) or f"item-row-{r}"
        bench = tidy(items_ws.get(f"B{r}")) or "Other Bench"
        cost = number(items_ws.get(f"E{r}"))
        ingredient_list = ingredients.get(item_id, [])
        if ingredient_list:
            total = 0
            all_known = True
            for material, qty in ingredient_list:
                unit = material_costs.get(material.casefold())
                if unit is None:
                    all_known = False
                    break
                total += qty * unit
            if all_known:
                cost = round(total, 2)

        own_price = number(items_ws.get(f"F{r}"))
        final_sell = own_price if own_price is not None else (2 * cost if cost is not None else None)
        custom_buy, custom_pct = buy_overrides.get(name.casefold(), (None, None))
        if custom_buy is not None:
            buy_price = custom_buy
            buy_source = "fixed item offer"
        elif final_sell is not None:
            buy_price = round(final_sell * (custom_pct if custom_pct is not None else default_buy_pct), 2)
            buy_source = "custom percentage" if custom_pct is not None else "percentage"
        else:
            buy_price = None
            buy_source = "not set"
        items.append({
            "id": f"item:{item_id}",
            "name": name,
            "group": bench,
            "type": "item",
            "craftCost": normalize_price(cost),
            "sellPrice": normalize_price(final_sell),
            "buyPrice": normalize_price(buy_price),
            "priceSource": "custom" if own_price is not None else "2x craft cost",
            "buySource": buy_source,
        })

    # Pawn Shop transaction price overrides are explicit and separate from
    # the public catalogue price (they apply in the sales calculator only).
    for record in items + materials:
        name = record["name"].casefold()
        record["shopPrice"] = normalize_price(shop_override.get(name, record["sellPrice"]))
        record["hasShopOverride"] = name in shop_override

    # Intentional displayed name changes are controlled here: the workbook
    # retains its original item names for formula compatibility.
    display_aliases = {"boost usb": "Blue USB", "stolen phone": "S Phone", "stolen radio": "S Radio", "oxy": "Ox*", "oxy (50%)": "Ox* (50%)"}
    for record in items + materials:
        record["displayName"] = display_aliases.get(record["name"].casefold(), record["name"])

    return {
        "brand": "Icy Rose Exchange",
        "source": source.name,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "defaultBuyPercent": default_buy_pct,
        "cash": {
            "stackValue": normalize_price(number(cash_ws.get("B7")) or 0),
            "rollValue": normalize_price(number(cash_ws.get("B8")) or 0)
        },
        "items": items,
        "materials": materials,
    }


def main():
    if len(sys.argv) != 3:
        print("Usage: python scripts/build_data.py input.xlsx site/data/prices.json")
        sys.exit(2)
    source, output = map(Path, sys.argv[1:])
    data = make_data(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    priced = sum(x["sellPrice"] is not None for x in data["items"] + data["materials"])
    print(f"Wrote {len(data['items'])} finished items, {len(data['materials'])} materials, {priced} selling prices to {output}")

if __name__ == "__main__":
    main()
