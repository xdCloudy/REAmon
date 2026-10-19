"""Export bounded function pseudocode and disassembly from an IDA batch run."""
import hashlib
import json
import os
import traceback

import ida_auto
import ida_bytes
import ida_funcs
import ida_hexrays
import ida_ida
import ida_kernwin
import ida_name
import ida_nalt
import idautils
import idc


def main():
    output_path = os.environ.get("REAMON_IDA_RESULT_PATH")
    if not output_path:
        raise RuntimeError("REAMON_IDA_RESULT_PATH was not supplied")

    input_path = ida_nalt.get_input_file_path()
    if not input_path or not os.path.isfile(input_path):
        raise RuntimeError("IDA input file could not be resolved")
    ida_auto.auto_wait()
    source_hash = hashlib.sha256()
    with open(input_path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            source_hash.update(chunk)

    maximum = max(1, min(1200, int(os.environ.get("REAMON_IDA_MAX_FUNCTIONS", "1200"))))
    functions = list(idautils.Functions())
    units = []
    calls = []
    failed = 0
    total_output_bytes = 0
    truncated = len(functions) > maximum
    hexrays_ready = ida_hexrays.init_hexrays_plugin()

    for start in functions[:maximum]:
        function = ida_funcs.get_func(start)
        if function is None:
            failed += 1
            continue
        end = function.end_ea
        name = ida_name.get_name(start) or "sub_%X" % start
        try:
            lines = []
            for address in idautils.FuncItems(start):
                text = idc.generate_disasm_line(address, 0)
                if text:
                    lines.append("%016X  %s" % (address, text))
                for target in idautils.CodeRefsFrom(address, False):
                    target_function = ida_funcs.get_func(target)
                    if target_function is None or target_function.start_ea == start:
                        continue
                    if len(calls) < 20000:
                        calls.append({
                            "fromAddress": "0x%X" % start,
                            "toAddress": "0x%X" % target_function.start_ea,
                            "fromName": name,
                            "toName": ida_name.get_name(target_function.start_ea) or "sub_%X" % target_function.start_ea,
                        })
            pseudocode = ""
            if hexrays_ready:
                cfunc = ida_hexrays.decompile(start)
                if cfunc:
                    pseudocode = "\n".join(str(line.line) for line in cfunc.get_pseudocode())
            if not pseudocode:
                failed += 1
                continue
            disassembly = "\n".join(lines)
            total_output_bytes += len(pseudocode.encode("utf-8")) + len(disassembly.encode("utf-8"))
            if total_output_bytes > 96 * 1024 * 1024:
                truncated = True
                break
            units.append({
                "name": name[:500],
                "address": "0x%X" % start,
                "sizeBytes": max(1, end - start),
                "pseudocode": pseudocode,
                "disassembly": disassembly,
            })
        except Exception:
            failed += 1

    result = {
        "status": "completed",
        "idaVersion": str(ida_kernwin.get_kernel_version() or "unknown")[:128],
        "architecture": str(ida_ida.inf_get_procname())[:128],
        "sourceSha256": source_hash.hexdigest(),
        "functionCount": len(functions),
        "failedFunctionCount": failed,
        "truncated": truncated,
        "units": units,
        "calls": calls[:20000],
    }
    temporary = output_path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as output:
        json.dump(result, output, ensure_ascii=False, separators=(",", ":"))
    os.replace(temporary, output_path)
    ida_kernwin.qexit(0)


try:
    main()
except Exception:
    traceback.print_exc()
    ida_kernwin.qexit(1)
