import os
from .parser import parse_dump
from .translator import translate_iseq

def main():
    iseqs, iseq_by_name = parse_dump('dumped_code.txt')
    print(f"Parsed {len(iseqs)} ISeqs.")

    entry_iseqs = []
    for iseq in iseqs:
        if iseq.name in ('<top (required)>', '<encoded>'):
            entry_iseqs.append(iseq)

    if not entry_iseqs:
        entry_iseqs = [iseqs[0]] if iseqs else []

    print(f"Entry ISeqs for translation: {entry_iseqs}")
    for iseq in entry_iseqs:
        print(f"Translating {iseq}...")
        ruby_code = translate_iseq(iseq, iseq_by_name)

        orig_filename = os.path.basename(iseq.filepath)
        output_file = f'decompiled_{orig_filename}'
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(f"# Decompiled from {iseq.filepath}\n\n")
            f.write(ruby_code)
        print(f"Decompiled code written to {output_file}")
