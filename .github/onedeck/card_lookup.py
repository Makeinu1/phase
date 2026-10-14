"""Oracle text and engine coverage for the card names listed in lookup.txt (any card type)."""
import json
import sys

wanted = [line.strip() for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
coverage = {card["card_name"]: card for card in json.load(open(sys.argv[2]))["cards"]}
out = []
for name in wanted:
    card = coverage.get(name)
    out.append({
        "name": name,
        "found": card is not None,
        "supported": card and card["supported"],
        "oracle_text": card and card.get("oracle_text"),
        "gaps": [
            {"handler": gap.get("handler"), "text": gap.get("source_text")}
            for gap in (card or {}).get("gap_details", [])
        ],
    })
json.dump(out, open(sys.argv[3], "w"), ensure_ascii=False, indent=1)
for row in out:
    print(f"::notice::{row['name']} supported={row['supported']}: {(row['oracle_text'] or '').replace(chr(10), ' / ')[:400]}")
