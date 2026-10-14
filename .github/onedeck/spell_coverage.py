"""Summarize engine coverage for every instant and sorcery (generic, not deck-specific)."""
import json
import sys

atomic = json.load(open(sys.argv[1]))["data"]
coverage = json.load(open(sys.argv[2]))
spells = {}
for name, faces in atomic.items():
    for face in faces:
        types = set(face.get("types", []))
        if types & {"Instant", "Sorcery"}:
            spells[face.get("faceName") or face["name"]] = {
                "types": sorted(types),
                "mana_cost": face.get("manaCost"),
            }
out = []
for card in coverage["cards"]:
    meta = spells.get(card["card_name"])
    if meta is None:
        continue
    out.append({
        "name": card["card_name"],
        "types": meta["types"],
        "mana_cost": meta["mana_cost"],
        "supported": card["supported"],
        "gaps": [
            {"handler": gap.get("handler"), "text": gap.get("source_text")}
            for gap in card.get("gap_details", [])
        ],
        "oracle_text": card.get("oracle_text"),
    })
out.sort(key=lambda row: row["name"])
json.dump(out, open(sys.argv[3], "w"), ensure_ascii=False, separators=(",", ":"))
print(len(out), "spells;", sum(not row["supported"] for row in out), "unsupported")
