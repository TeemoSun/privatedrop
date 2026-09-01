import csv
import gzip
import io
import json
import os
import sys
import urllib.request

URL = "http://storage.googleapis.com/play_public/supported_devices.csv"
OUTPUT_JSON = os.path.join(os.path.dirname(__file__), "..", "frontend", "src", "lib", "android-models.json")

# Curated overrides for popular domestic Chinese models (which don't have GMS / missing in Google Play list)
MANUAL_OVERRIDES = {
    "RMX3700": "Realme GT Neo5 SE",
    "RMX3706": "Realme GT Neo5",
    "RMX3708": "Realme GT Neo5 240W",
    "RMX3840": "Realme 12 Pro+",
    "RMX3842": "Realme 12 Pro",
    "RMX3995": "Realme 13 Pro+",
    "RMX3988": "Realme 13 Pro",
    "PJD110": "OnePlus 12",
    "PJF110": "OnePlus Ace 3V",
    "PJE110": "OPPO Find X7 Ultra",
    "PHY110": "OPPO Find X7",
    "PKB110": "OnePlus 13",
    "V2309A": "vivo X100 Pro",
    "V2302A": "vivo X100",
    "V2329A": "vivo X100 Ultra",
    "V2324A": "vivo X100s",
    "V2405A": "vivo X200",
    "V2415A": "vivo X200 Pro",
    "V2419A": "vivo X200 Pro mini",
    "24129PN74C": "Xiaomi 15 Pro",
    "24122RKC7C": "Redmi K80 Pro",
    "24117RK2CC": "Redmi K80",
    "23116PN5BC": "Xiaomi 14 Pro",
    "24030PN60C": "Xiaomi 14 Ultra",
    "24101PNB7C": "Xiaomi 15",
    "ALN-AL00": "Huawei Mate 60 Pro",
    "ALN-AL10": "Huawei Mate 60 Pro+",
    "ALN-AL80": "Huawei Mate 60 RS",
    "BRA-AL00": "Huawei Mate 60",
    "HBP-AL00": "Huawei Pura 70",
    "HBP-AL10": "Huawei Pura 70 Pro",
    "HBP-AL20": "Huawei Pura 70 Pro+",
    "HBP-AL80": "Huawei Pura 70 Ultra",
}

BRAND_CASING = {
    "realme": "Realme",
    "samsung": "Samsung",
    "xiaomi": "Xiaomi",
    "huawei": "Huawei",
    "honor": "Honor",
    "oppo": "OPPO",
    "vivo": "vivo",
    "oneplus": "OnePlus",
    "google": "Google",
    "sony": "Sony",
    "motorola": "Motorola",
    "asus": "ASUS",
    "lenovo": "Lenovo",
    "zte": "ZTE",
    "meizu": "Meizu",
    "nothing": "Nothing",
    "iqoo": "iQOO",
    "redmi": "Redmi",
    "poco": "POCO",
    "blackshark": "Black Shark",
    "nokia": "Nokia",
    "lg": "LG",
    "htc": "HTC",
    "tcl": "TCL",
    "infinix": "Infinix",
    "tecno": "Tecno",
    "itel": "itel",
}

def format_brand(brand: str) -> str:
    brand_clean = brand.strip()
    return BRAND_CASING.get(brand_clean.lower(), brand_clean.title())

def format_device_name(brand: str, marketing_name: str) -> str:
    brand_fmt = format_brand(brand)
    mkt = marketing_name.strip()
    
    if not mkt:
        return brand_fmt
    
    mkt_lower = mkt.lower()
    brand_lower = brand.lower().strip()
    
    if mkt_lower.startswith(brand_lower):
        rest = mkt[len(brand_lower):].strip()
        return f"{brand_fmt} {rest}".strip()
    elif mkt_lower.startswith("redmi") or mkt_lower.startswith("poco") or mkt_lower.startswith("iqoo") or mkt_lower.startswith("真我"):
        if mkt_lower.startswith("真我"):
            return f"Realme {mkt}"
        return mkt
    else:
        return f"{brand_fmt} {mkt}".strip()

def main():
    print(f"Downloading Google Play supported devices CSV from {URL}...")
    req = urllib.request.Request(
        URL,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw_data = resp.read()

    print(f"Downloaded {len(raw_data) / 1024 / 1024:.2f} MB raw CSV.")

    text = None
    for enc in ("utf-16", "utf-16-le", "utf-8-sig", "utf-8"):
        try:
            text = raw_data.decode(enc)
            break
        except Exception:
            continue

    if not text:
        print("Failed to decode CSV", file=sys.stderr)
        sys.exit(1)

    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)
    print(f"Header: {header}")

    models_map = {}
    total_rows = 0

    for row in reader:
        total_rows += 1
        if len(row) < 4:
            continue
        brand, marketing_name, device, model = [c.strip() for c in row[:4]]
        if not model or not brand:
            continue
        
        clean_model = model.strip()
        if len(clean_model) < 2 or clean_model in ("K", "Mobile", "generic", "Android"):
            continue

        full_name = format_device_name(brand, marketing_name)
        if clean_model.lower() == full_name.lower():
            continue

        if clean_model not in models_map:
            models_map[clean_model] = full_name
        else:
            existing = models_map[clean_model]
            if len(full_name) > len(existing) and not existing.endswith(clean_model):
                models_map[clean_model] = full_name

    # Merge manual overrides
    for k, v in MANUAL_OVERRIDES.items():
        models_map[k] = v

    print(f"Processed {total_rows} rows from Google Play list.")
    print(f"Extracted {len(models_map)} unique model mappings.")

    os.makedirs(os.path.dirname(OUTPUT_JSON), exist_ok=True)
    json_data = json.dumps(models_map, ensure_ascii=False, separators=(',', ':'))
    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        f.write(json_data)

    raw_json_bytes = len(json_data.encode("utf-8"))
    gzip_bytes = len(gzip.compress(json_data.encode("utf-8")))

    print("\n--- File Size Statistics ---")
    print(f"Output Path: {OUTPUT_JSON}")
    print(f"Raw JSON Size: {raw_json_bytes / 1024 / 1024:.2f} MB ({raw_json_bytes / 1024:.1f} KB)")
    print(f"Gzipped Size (HTTP Transfer): {gzip_bytes / 1024:.1f} KB")

if __name__ == "__main__":
    main()
