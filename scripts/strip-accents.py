# Quita diacriticos y signos invertidos de los literales de un archivo de codigo,
# para que el texto sobreviva a un pipe donde la consola no usa UTF-8.
# Uso: python strip-accents.py <archivo> [archivo...]
import sys
import unicodedata

REPLACEMENTS = {"¿": "", "¡": "", "\u00a0": " "}


def clean(text):
    out = []
    for char in text:
        if char in REPLACEMENTS:
            out.append(REPLACEMENTS[char])
            continue
        if ord(char) > 127:
            decomposed = unicodedata.normalize("NFD", char)
            base = "".join(part for part in decomposed if not unicodedata.combining(part))
            if base and all(ord(part) < 128 for part in base):
                out.append(base)
                continue
        out.append(char)
    return "".join(out)


for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as handle:
        original = handle.read()
    cleaned = clean(original)
    if cleaned != original:
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(cleaned)
        print(f"{path}: normalizado")
    else:
        print(f"{path}: sin cambios")
