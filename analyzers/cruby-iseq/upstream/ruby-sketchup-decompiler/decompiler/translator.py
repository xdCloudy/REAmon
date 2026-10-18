import re
import os
from .core.handlers import handle_simple_op
from .utils import (
    strip_outer_parens, get_put_value, get_method_args,
    wrap_if_complex, negate_expression, is_unconditionally_terminating,
    sanitize_ruby_identifier
)

def translate_iseq(iseq, all_iseqs):
    skipped_offsets = set()
    defaults = {}

    def indent_code(lines, indent="  "):
        flat_lines = []
        for line in lines:
            flat_lines.extend(line.splitlines())
        return "\n".join(f"{indent}{l}" for l in flat_lines)

    from .core.context import TranslationContext
    from .core.branching import BranchAnalyzer

    ctx = TranslationContext(iseq, all_iseqs)

    offset_to_idx = ctx.offset_to_idx
    backward_branches = ctx.backward_branches
    resolved_counts = ctx.resolved_counts
    resolve_child = ctx.resolve_child
    is_class_or_module = ctx.is_class_or_module
    is_block_or_class = ctx.is_block_or_class

    def translate_range(start_idx, end_idx, stack, pop_final=True, is_root=False, ignored_catches=None):
        if ignored_catches is None:
            ignored_catches = set()
        statements = []

        def append_statement(stmt):
            """
            Hàm helper an toàn để ngăn chặn ghi đè code chết (dead code)
            sau khi khối lệnh hiện tại đã kết thúc bằng một lệnh nhảy hoặc return vô điều kiện.
            Tự động bóc ngoặc đơn thừa bao quanh cả câu lệnh khi có thể.
            """
            if statements and is_unconditionally_terminating(statements[-1]):
                return
            statements.append(strip_outer_parens(stmt))

        analyzer = BranchAnalyzer(ctx, translate_range)

        pc = start_idx
        while pc < end_idx:
            # Check if current pc starts any rescue/catch regions
            current_offset = iseq.instructions[pc]['offset']
            matching_catches = [c for c in iseq.catch_table if c['type'] == 'rescue' and c['st'] == current_offset and id(c) not in ignored_catches]
            if matching_catches:
                # Find the maximum ed offset
                ed_offset = max(c['ed'] for c in matching_catches)
                ed_idx = offset_to_idx.get(ed_offset)
                if ed_idx is not None and ed_idx >= pc:
                    # Translate the body of the begin block
                    body_stack = list(stack)
                    new_ignored = ignored_catches.union(id(c) for c in matching_catches)
                    body_statements = translate_range(pc, ed_idx + 1, body_stack, pop_final=False, is_root=False, ignored_catches=new_ignored)

                    stack.clear()
                    stack.extend(body_stack)

                    # Translate rescue clauses
                    rescue_clauses = []

                    # Map rescue catches to child rescue iseqs
                    all_rescue_iseqs = [child for child in iseq.children if "rescue" in child.name]
                    all_rescue_catches = [c for c in iseq.catch_table if c['type'] == 'rescue']

                    for entry in matching_catches:
                        rescue_iseq = None
                        try:
                            catch_idx = all_rescue_catches.index(entry)
                            if catch_idx < len(all_rescue_iseqs):
                                rescue_iseq = all_rescue_iseqs[catch_idx]
                        except ValueError:
                            pass

                        exc_class = "StandardError"
                        rescue_code = ""
                        if rescue_iseq:
                            # Extract exception class
                            for instr in rescue_iseq.instructions:
                                if instr['op'] == 'getconstant':
                                    exc_class = instr['args'].lstrip(':').strip()
                                    break

                            # Find rescue body between branchunless and its target
                            branchunless_idx = -1
                            target_offset = -1
                            for idx, instr in enumerate(rescue_iseq.instructions):
                                if instr['op'] == 'branchunless':
                                    branchunless_idx = idx
                                    try:
                                        target_offset = int(instr['args'].split()[-1])
                                    except ValueError:
                                        pass
                                    break

                            if branchunless_idx != -1 and target_offset != -1:
                                target_idx = -1
                                for idx, instr in enumerate(rescue_iseq.instructions):
                                    if instr['offset'] == target_offset:
                                        target_idx = idx
                                        break
                                if target_idx != -1:
                                    # Copy and slice instructions to translate only the rescue branch
                                    import copy
                                    sub_iseq = copy.copy(rescue_iseq)
                                    sub_iseq.instructions = rescue_iseq.instructions[branchunless_idx + 1 : target_idx]
                                    while sub_iseq.instructions and sub_iseq.instructions[-1]['op'] == 'leave':
                                        sub_iseq.instructions.pop()
                                    # Backup and restore resolved_counts to prevent recursion side effects
                                    saved_counts = resolved_counts.copy()
                                    rescue_code = translate_iseq(sub_iseq, all_iseqs)
                                    resolved_counts.clear()
                                    resolved_counts.update(saved_counts)

                        rescue_str = indent_code([rescue_code]) if rescue_code else ""
                        clause = f"rescue {exc_class}"
                        if rescue_str:
                            clause += f"\n{rescue_str}"
                        rescue_clauses.append(clause)

                    body_str = indent_code(body_statements)
                    rescue_block = f"begin\n{body_str}\n" + "\n".join(rescue_clauses) + "\nend"
                    append_statement(rescue_block)

                    # Advance pc past the end of the guarded block
                    pc = ed_idx + 1
                    continue

            # Check for backward branches (begin...end while/until loops)
            if pc in backward_branches:
                valid_branches = [b for b in backward_branches[pc] if b < end_idx]
                if valid_branches:
                    loop_end_idx = max(valid_branches)
                    loop_branch_op = iseq.instructions[loop_end_idx]['op']

                    if loop_branch_op == 'jump':
                        body_stack = list(stack)
                        body_code = translate_range(pc, loop_end_idx, body_stack, pop_final=False)
                        body_str = indent_code(body_code)
                        append_statement(f"while true\n{body_str}\nend")
                        stack.clear()
                        stack.extend(body_stack)
                        pc = loop_end_idx + 1
                        continue
                    elif loop_branch_op in ('branchif', 'branchunless'):
                        body_stack = list(stack)
                        body_code = translate_range(pc, loop_end_idx, body_stack, pop_final=False)
                        cond = body_stack.pop() if body_stack else 'true'
                        body_str = indent_code(body_code)
                        break_word = "unless" if loop_branch_op == "branchif" else "if"
                        body_str += f"\n  break {break_word} {cond}"
                        append_statement(f"while true\n{body_str}\nend")
                        stack.clear()
                        stack.extend(body_stack)
                        pc = loop_end_idx + 1
                        continue

            instr = iseq.instructions[pc]
            op = instr['op']
            args = instr['args']
            offset = instr['offset']

            if offset in skipped_offsets:
                pc += 1
                continue

            if op in ('putnil', 'opt_getinlinecache'):
                stack.append('nil')
            elif op == 'defined':
                parts = args.split(', ')
                type_flag = parts[0].strip()
                const_name = parts[1].lstrip(':').strip() if len(parts) >= 2 else ""

                is_nested_defined = False
                if type_flag == 'constant' and pc + 2 < end_idx:
                    next_instr = iseq.instructions[pc + 1]
                    if next_instr['op'] == 'branchunless':
                        try:
                            target_offset = int(next_instr['args'].split()[-1])
                            if target_offset in offset_to_idx:
                                target_idx = offset_to_idx[target_offset]
                                defined_from_idx = -1
                                for scan_idx in range(pc + 2, target_idx):
                                    scan_instr = iseq.instructions[scan_idx]
                                    if scan_instr['op'] == 'defined' and 'constant-from' in scan_instr['args']:
                                        defined_from_idx = scan_idx
                                        break

                                if defined_from_idx != -1 and defined_from_idx + 2 < len(iseq.instructions):
                                    swap_instr = iseq.instructions[defined_from_idx + 1]
                                    pop_instr = iseq.instructions[defined_from_idx + 2]
                                    if swap_instr['op'] == 'swap' and pop_instr['op'] == 'pop' and defined_from_idx + 3 == target_idx:
                                        is_nested_defined = True
                                        from_parts = iseq.instructions[defined_from_idx]['args'].split(', ')
                                        child_const = from_parts[1].lstrip(':').strip()

                                        stack.append(f"defined?({const_name}::{child_const})")
                                        pc = target_idx
                                        continue
                        except (ValueError, IndexError):
                            pass

                if not is_nested_defined:
                    if type_flag == 'constant-from':
                        parent = stack.pop() if stack else 'self'
                        if parent in ('nil', 'self'):
                            stack.append(f"defined?({const_name})")
                        else:
                            stack.append(f"defined?({parent}::{const_name})")
                    else:
                        stack.append(f"defined?({const_name})")
            elif op == 'putself':
                stack.append('self')
            elif op in ('putobject_INT2FIX_0_', 'putobject_INT2FIX_0'):
                stack.append('0')
            elif op in ('putobject_INT2FIX_1_', 'putobject_INT2FIX_1'):
                stack.append('1')
            elif op in ('putobject', 'putstring', 'duparray', 'duphash'):
                val = args.strip()
                if op == 'putstring':
                    content = val
                    if (content.startswith('"') and content.endswith('"')) or (content.startswith("'") and content.endswith("'")):
                        content = content[1:-1]
                    if iseq.filepath and os.path.normpath(content).lower() == os.path.normpath(iseq.filepath).lower():
                        val = '__FILE__'
                if op == 'putobject' and '..' in val and not (val.startswith('(') or val.startswith('"') or val.startswith("'") or val.startswith(':')):
                    val = f"({val})"
                stack.append(val)
            elif op.startswith('getlocal') or op in ('getblockparamproxy', 'getblockparam'):
                raw_var_name = args.split('@')[0].strip()
                local_idx_match = re.search(r'@(\d+)', args)
                local_idx = int(local_idx_match.group(1)) if local_idx_match else pc
                var_name = sanitize_ruby_identifier(raw_var_name, local_idx)
                stack.append(var_name)
            elif op.startswith('setlocal'):
                raw_var_name = args.split('@')[0].strip()
                local_idx_match = re.search(r'@(\d+)', args)
                local_idx = int(local_idx_match.group(1)) if local_idx_match else pc
                var_name = sanitize_ruby_identifier(raw_var_name, local_idx)
                if stack:
                    val = stack.pop()
                    clean_val = strip_outer_parens(val)
                    append_statement(f"{var_name} = {clean_val}")
                    if stack and stack[-1] == val:
                        stack[-1] = var_name
            elif op == 'getglobal':
                stack.append(args.strip())
            elif op == 'setglobal':
                if stack:
                    val = stack.pop()
                    append_statement(f"{args.strip()} = {strip_outer_parens(val)}")
                    if stack and stack[-1] == val:
                        stack[-1] = args.strip()
            elif op == 'getconstant':
                const_name = args.lstrip(':').strip()
                flag = stack.pop() if stack else 'true'
                parent = stack.pop() if stack else 'nil'
                if parent not in ('nil', 'self') and parent != '<empty_cond>':
                    stack.append(f"{parent}::{const_name}")
                else:
                    stack.append(const_name)
            elif op == 'setconstant':
                const_name = args.lstrip(':').strip()
                if len(stack) >= 2:
                    parent = stack.pop()
                    val = stack.pop()
                    clean_val = strip_outer_parens(val)
                    if parent.isdigit() or parent in ('nil', 'self'):
                        append_statement(f"{const_name} = {clean_val}")
                    else:
                        append_statement(f"{parent}::{const_name} = {clean_val}")
                    if stack and stack[-1] == val:
                        stack[-1] = const_name
                elif stack:
                    val = stack.pop()
                    append_statement(f"{const_name} = {strip_outer_parens(val)}")
                    if stack and stack[-1] == val:
                        stack[-1] = const_name
            elif op == 'getinstancevariable':
                var_name = args.split(',')[0].lstrip(':').strip()
                stack.append(var_name)
            elif op == 'getspecial':
                parts = args.split(', ')
                key = int(parts[0])
                type_val = int(parts[1])
                if key == 1:
                    if type_val == 77:
                        stack.append("$&")
                    elif type_val == 193:
                        stack.append("$" + "`")
                    elif type_val == 79:
                        stack.append("$'")
                    elif type_val == 87:
                        stack.append("$+")
                    elif type_val % 2 == 0:
                        stack.append(f"${type_val // 2}")
                    else:
                        stack.append(f"${(type_val - 1) // 2}")
                else:
                    stack.append(f"special_{key}_{type_val}")
            elif op == 'setinstancevariable':
                var_name = args.split(',')[0].lstrip(':').strip()
                if stack:
                    val = stack.pop()
                    append_statement(f"{var_name} = {strip_outer_parens(val)}")
                    if stack and stack[-1] == val:
                        stack[-1] = var_name
            elif op == 'getclassvariable':
                var_name = args.split(',')[0].lstrip(':').strip()
                stack.append(var_name)
            elif op == 'setclassvariable':
                var_name = args.split(',')[0].lstrip(':').strip()
                if stack:
                    val = stack.pop()
                    append_statement(f"{var_name} = {strip_outer_parens(val)}")
                    if stack and stack[-1] == val:
                        stack[-1] = var_name
            elif op in ('opt_send_without_block', 'send'):
                m_mid = re.search(r'mid:([^,\s>]+)', args)
                m_argc = re.search(r'argc:(\d+)', args)
                m_kw = re.search(r'kw:\[(.*?)\]', args)

                if m_mid and m_argc:
                    M = m_mid.group(1)
                    A = int(m_argc.group(1))
                else:
                    M = 'unknown_method'
                    A = 0

                kw_list = []
                if m_kw:
                    kw_list = [k.strip() for k in m_kw.group(1).split(',') if k.strip()]

                has_blockarg = 'ARGS_BLOCKARG' in args
                blockarg = None
                if has_blockarg and stack:
                    blockarg = stack.pop()

                method_args = []
                for _ in range(A):
                    if stack:
                        method_args.append(stack.pop())
                method_args.reverse()
                # Bóc ngoặc đơn thừa bao quanh từng tham số
                method_args = [strip_outer_parens(a) for a in method_args]

                formatted_args = []
                if kw_list and len(method_args) >= len(kw_list):
                    num_pos = len(method_args) - len(kw_list)
                    pos_args = method_args[:num_pos]
                    kw_vals = method_args[num_pos:]

                    formatted_args.extend(pos_args)
                    for k, v in zip(kw_list, kw_vals):
                        formatted_args.append(f"{k}: {v}")
                else:
                    formatted_args = method_args

                if has_blockarg and blockarg:
                    formatted_args.append(f"&{blockarg}")

                if stack:
                    recv = stack.pop()
                else:
                    recv = 'self'

                block_part = ""
                if op == 'send':
                    parts = args.split(', ')
                    block_name = parts[-1].strip()
                    block_iseq = resolve_child(block_name, pc)
                    if block_iseq:
                        block_skipped, block_defaults = scan_defaults(block_iseq)
                        block_code = translate_iseq(block_iseq, all_iseqs)
                        block_args_list = get_method_args(block_iseq, block_defaults)
                        block_args_str = ", ".join(block_args_list)
                        block_args_fmt = f"|{block_args_str}|" if block_args_str else ""
                        indented_code = indent_code([block_code])
                        if M == 'lambda':
                            block_part = f" ->({block_args_str}) {{\n{indented_code}\n}}"
                        else:
                            block_part = f" do {block_args_fmt}\n{indented_code}\nend"

                expr = ""
                if recv in ('self', 'nil') and M in ('private', 'protected', 'public') and not formatted_args:
                    expr = M
                elif M == '-@' and not formatted_args:
                    # Sửa lỗi unary minus (.-@) phát sinh từ các phương thức một ngôi tối ưu hóa trong YARV
                    if re.match(r'^[@$]?[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$', recv) or recv.isdigit():
                        expr = f"-{recv}"
                    else:
                        expr = f"-({recv})"
                elif M == '+@' and not formatted_args:
                    expr = f"+{recv}"
                elif M == '~@' and not formatted_args:
                    expr = f"~{recv}"
                elif M == '===' and len(formatted_args) == 1:
                    expr = f"{recv} === {formatted_args[0]}"
                elif recv in ('self', 'nil') and M == 'class':
                    expr = "self.class"
                elif recv in ('self', 'nil'):
                    if M in ('raise', 'exit', 'require', 'load', 'puts', 'p', 'require_relative'):
                        if formatted_args:
                            expr = f"{M} {', '.join(formatted_args)}"
                        else:
                            expr = M
                    else:
                        expr = f"{M}({', '.join(formatted_args)})"
                else:
                    if M == 'core#set_method_alias':
                        if len(formatted_args) >= 3:
                            expr = f"alias_method {formatted_args[1]}, {formatted_args[2]}"
                        else:
                            expr = f"alias_method {formatted_args[0]}, {formatted_args[1]}"
                    elif M == 'core#hash_merge_kwd':
                        if len(formatted_args) >= 2:
                            expr = f"{formatted_args[0]}.merge({formatted_args[1]})"
                        elif formatted_args:
                            expr = formatted_args[0]
                        else:
                            expr = "{}"
                    elif M == '[]':
                        expr = f"{recv}[{', '.join(formatted_args)}]"
                    elif M == '[]=' and len(formatted_args) >= 2:
                        expr = f"{recv}[{formatted_args[0]}] = {formatted_args[1]}"
                    elif M in ('+', '-', '==', '<', '>', '!=', '<=', '>='):
                        expr = f"({recv} {M} {formatted_args[0]})"
                    else:
                        if formatted_args:
                            expr = f"{recv}.{M}({', '.join(formatted_args)})"
                        else:
                            expr = f"{recv}.{M}"

                if block_part:
                    if M == 'lambda':
                        expr = block_part
                    else:
                        expr += block_part

                stack.append(expr)

            elif handle_simple_op(op, args, stack, append_statement):
                pass
            elif op in ('opt_match_with_out_recv', 'opt_match'):
                if len(stack) >= 2:
                    target = stack.pop()
                    pattern = stack.pop()
                    stack.append(f"({pattern} =~ {target})")
            elif op == 'opt_regexpmatch2':
                if len(stack) >= 2:
                    pattern = stack.pop()
                    target = stack.pop()
                    stack.append(f"({target} =~ {pattern})")
            elif op == 'dup':
                is_str_interpolation = False
                if pc + 5 < end_idx:
                    i1 = iseq.instructions[pc + 1]
                    i2 = iseq.instructions[pc + 2]
                    i3 = iseq.instructions[pc + 3]
                    i4 = iseq.instructions[pc + 4]
                    i5 = iseq.instructions[pc + 5]
                    if (i1['op'] == 'checktype' and 'T_STRING' in i1['args'] and
                        i2['op'] == 'branchif' and
                        i3['op'] == 'dup' and
                        (i4['op'] in ('opt_send_without_block', 'send') and 'to_s' in i4['args']) and
                        i5['op'] == 'tostring'):
                        try:
                            target_offset = int(i2['args'].split()[-1])
                            if target_offset in offset_to_idx:
                                target_idx = offset_to_idx[target_offset]
                                if target_idx == pc + 6:
                                    is_str_interpolation = True
                        except ValueError:
                            pass
                if is_str_interpolation:
                    if stack:
                        val = stack.pop()
                        stack.append(f"{val}.to_s")
                    pc += 6
                    continue

                is_short_circuit = False
                if pc + 2 < end_idx:
                    next_instr = iseq.instructions[pc + 1]
                    next_next_instr = iseq.instructions[pc + 2]
                    if next_instr['op'] in ('branchunless', 'branchif', 'branchnil') and next_next_instr['op'] == 'pop':
                        branch_op = next_instr['op']
                        try:
                            target_offset = int(next_instr['args'].split()[-1])
                            if target_offset in offset_to_idx:
                                target_idx = offset_to_idx[target_offset]
                                if target_idx > pc + 2:
                                    is_short_circuit = True
                        except ValueError:
                            pass

                if is_short_circuit:
                    sub_stack = []
                    sub_statements = translate_range(pc + 3, target_idx, sub_stack, pop_final=False, ignored_catches=ignored_catches)
                    if sub_stack:
                        B_expr = sub_stack[-1]
                        A_expr = stack.pop() if stack else '<empty_cond>'

                        # Hỗ trợ toán tử gán ngắn mạch (||= và &&=)
                        is_assignment_shortcut = False
                        if sub_statements and sub_statements[-1].startswith(f"{A_expr} = "):
                            is_assignment_shortcut = True
                            rhs = sub_statements[-1].split(" = ", 1)[1]
                            sub_statements.pop() # Loại bỏ câu lệnh gán vô điều kiện
                            op_symbol = '&&=' if branch_op == 'branchunless' else '||='
                            for stmt in sub_statements:
                                append_statement(stmt)
                            stack.append(f"{A_expr} {op_symbol} {rhs}")
                        else:
                            op_symbol = '&&' if branch_op == 'branchunless' else '||'
                            for stmt in sub_statements:
                                append_statement(stmt)
                            stack.append(f"({A_expr} {op_symbol} {B_expr})")
                        pc = target_idx - 1
                    else:
                        if stack and sub_statements and any(any(stmt.strip().startswith(w) for w in ('break', 'next', 'return', 'raise', 'exit')) for stmt in sub_statements):
                            A_expr = stack.pop()
                            if len(sub_statements) == 1 and any(sub_statements[0].startswith(w) for w in ('break', 'next', 'return', 'raise', 'exit')):
                                cond_word = 'if' if branch_op == 'branchunless' else 'unless'
                                append_statement(f"{sub_statements[0]} {cond_word} {A_expr}")
                            else:
                                cond_word = 'if' if branch_op == 'branchunless' else 'unless'
                                indented = indent_code(sub_statements)
                                append_statement(f"{cond_word} {A_expr}\n{indented}\nend")
                            pc = target_idx - 1
                        else:
                            if stack:
                                stack.append(stack[-1])

                else:
                    if stack:
                        stack.append(stack[-1])
            elif op == 'dupn':
                n = int(args.strip())
                if len(stack) >= n:
                    stack.extend(stack[-n:])
            elif op == 'setn':
                n = int(args.strip())
                if len(stack) >= n + 1:
                    stack[-n - 1] = stack[-1]
            elif op == 'adjuststack':
                n = int(args.strip())
                if len(stack) >= n + 1:
                    top = stack.pop()
                    for _ in range(n):
                        if stack:
                            stack.pop()
                    stack.append(top)
            elif op == 'pop':
                if stack:
                    val = stack.pop()
                    # Bộ lọc cực mạnh chống định danh/biến cục bộ/biến instance rơi rớt trên Stack làm bẩn dòng code
                    is_filtered = False
                    if re.match(r'^(true|false|nil|self|\[\]|\{\})$', val) or \
                       re.match(r'^@{1,2}[a-zA-Z_][a-zA-Z0-9_]*[!?]?$', val) or \
                       re.match(r'^\$[a-zA-Z_][a-zA-Z0-9_]*[!?]?$', val) or \
                       re.match(r'^[a-zA-Z_][a-zA-Z0-9_]*[!?]?$', val) or \
                       re.match(r'^:[a-zA-Z0-9_!?=]+$', val) or \
                       re.match(r'^["\'].*["\']$', val) or \
                       re.match(r'^\-?\d+(\.\d+)?$', val):
                        is_filtered = True
                    # Bỏ qua phép toán toán học đơn giản không có side effect
                    elif re.match(r'^\s*\(?[a-zA-Z0-9_@$\[\]\:\.\'\"]+\s*[\+\-\*\/]\s*[a-zA-Z0-9_@$\[\]\:\.\'\"]+\)?\s*$', val):
                        is_filtered = True
                    # Bỏ qua truy cập mảng/hash đơn giản không có phép gán
                    elif re.match(r'^\s*[a-zA-Z0-9_@$\[\]\:\.]+(\[[^\]=]+\])+\s*$', val) and '=' not in val:
                        is_filtered = True

                    if not is_filtered:
                        if statements and is_unconditionally_terminating(statements[-1]):
                            pass
                        elif (any(c in val for c in ('.', '(', '[', '=', 'do', '->', 'if', 'unless', ' ? ', '<<', '>>', '&', '|', '^')) or
                            val.startswith(('raise ', 'require ', 'puts ', 'p ', 'load ', 'exit ', 'require_relative ')) or
                            val in ('raise', 'exit', 'yield')):
                            append_statement(val)
            elif op == 'swap':
                if len(stack) >= 2:
                    stack[-1], stack[-2] = stack[-2], stack[-1]
            elif op == 'opt_aref_with':
                parts = args.split(', ')
                key = parts[0].strip()
                if stack:
                    recv = stack.pop()
                    stack.append(f"{recv}[{key}]")
                else:
                    stack.append(f"[{key}]")
            elif op == 'checktype':
                if stack:
                    val = stack.pop()
                    type_map = {'T_STRING': 'String', 'T_ARRAY': 'Array', 'T_HASH': 'Hash'}
                    t_name = type_map.get(args.strip(), 'Object')
                    stack.append(f"{val}.is_a?({t_name})")
            elif op == 'checkmatch':
                flag = int(args.split()[0])
                if len(stack) >= 2:
                    pattern = stack.pop()
                    target = stack.pop()
                    stack.append(f"({pattern} === {target})")
            elif op == 'tostring':
                if stack:
                    val = stack.pop()
                    stack.append(f"{val}.to_s")
            elif op == 'concatstrings':
                n = int(args.split()[0])
                elems = []
                for _ in range(n):
                    if stack:
                        elems.append(stack.pop())
                elems.reverse()
                stack.append(" + ".join(elems))
            elif op == 'expandarray':
                parts = args.split(', ')
                num = int(parts[0].strip())
                if stack:
                    arr = stack.pop()
                    for i in reversed(range(num)):
                        stack.append(f"{arr}[{i}]")
            elif op == 'putspecialobject':
                stack.append(args.strip())
            elif op == 'newarray':
                n = int(args.split()[0])
                arr_elems = []
                for _ in range(n):
                    if stack:
                        arr_elems.append(stack.pop())
                arr_elems.reverse()
                arr_elems = [strip_outer_parens(e) for e in arr_elems]
                stack.append(f"[{', '.join(arr_elems)}]")
            elif op == 'newhash':
                n = int(args.split()[0])
                hash_elems = []
                for _ in range(n):
                    if stack:
                        hash_elems.append(stack.pop())
                hash_elems.reverse()
                pairs = []
                for i in range(0, len(hash_elems), 2):
                    k = strip_outer_parens(hash_elems[i])
                    v = strip_outer_parens(hash_elems[i+1]) if i+1 < len(hash_elems) else 'nil'
                    pairs.append(f"{k} => {v}")
                stack.append(f"{{ {', '.join(pairs)} }}")
            elif op == 'defineclass':
                parts = args.split(', ')
                class_name = parts[0].lstrip(':').strip()
                body_name = parts[1].strip()
                class_type = int(parts[2].split()[0])

                superclass = 'nil'
                cbase = 'nil'
                if len(stack) >= 2:
                    superclass = stack.pop()
                    cbase = stack.pop()
                elif stack:
                    stack.pop()

                body_code = ""
                body_iseq = resolve_child(body_name, pc)
                if body_iseq:
                    body_code = translate_iseq(body_iseq, all_iseqs)

                indented_body = indent_code([body_code])
                type_flag = class_type & 3
                if type_flag == 2:
                    class_header = f"module {class_name}"
                elif type_flag == 1:
                    class_header = f"class << {cbase}"
                else:
                    superclass_str = f" < {superclass}" if superclass not in ('nil', 'Object') else ""
                    class_header = f"class {class_name}{superclass_str}"
                append_statement(f"{class_header}\n{indented_body}\nend")
            elif op in ('definesmethod', 'definemethod'):
                parts = args.split(', ')
                method_name = parts[0].lstrip(':').strip()
                body_name = parts[1].strip()

                if op == 'definesmethod' and stack:
                    recv = stack.pop()
                else:
                    recv = "self"

                body_code = ""
                method_args_str = ""
                body_iseq = resolve_child(body_name, pc)
                if body_iseq:
                    body_skipped, body_defaults = scan_defaults(body_iseq)
                    body_code = translate_iseq(body_iseq, all_iseqs)
                    args_list = get_method_args(body_iseq, body_defaults)
                    method_args_str = f"({', '.join(args_list)})" if args_list else ""

                indented_body = indent_code([body_code])
                prefix = "self." if op == 'definesmethod' else ""
                append_statement(f"def {prefix}{method_name}{method_args_str}\n{indented_body}\nend")
            elif op == 'opt_case_dispatch':
                expr = stack.pop() if stack else '<empty_cond>'
                if stack and stack[-1] == expr:
                    stack.pop()
                cases = []
                scan_pc = pc + 1
                while scan_pc + 3 < end_idx:
                    instr1 = iseq.instructions[scan_pc]
                    instr2 = iseq.instructions[scan_pc + 1]
                    instr3 = iseq.instructions[scan_pc + 2]
                    instr4 = iseq.instructions[scan_pc + 3]
                    val = get_put_value(instr2)
                    if (instr1['op'] == 'dup' and
                        val is not None and
                        instr3['op'] == 'checkmatch' and
                        instr4['op'] == 'branchif'):
                        key = val
                        target_offset = int(instr4['args'].split()[-1])
                        target_idx = offset_to_idx[target_offset]
                        cases.append((key, target_idx))
                        scan_pc += 4
                    else:
                        break

                after_case_idx = end_idx
                if cases:
                    max_target = pc
                    for scan_idx in range(pc, min(end_idx, pc + 100)):
                        scan_instr = iseq.instructions[scan_idx]
                        if isinstance(scan_instr, dict) and scan_instr.get('op') == 'jump':
                            try:
                                t = int(scan_instr['args'][0]) if isinstance(scan_instr['args'], list) else int(scan_instr['args'].split()[-1])
                                if t > max_target and (not cases or t >= iseq.instructions[cases[-1][1]]['offset']):
                                    max_target = t
                            except ValueError:
                                pass
                    if max_target > pc and max_target in offset_to_idx:
                        after_case_idx = offset_to_idx[max_target]

                case_lines = [f"case {expr}"]
                has_when_val = False
                for i, (key, target_idx) in enumerate(cases):
                    next_target_idx = cases[i+1][1] if i+1 < len(cases) else after_case_idx
                    when_stack = list(stack)
                    when_code = translate_range(target_idx + 1, next_target_idx - 1, when_stack, pop_final=False)

                    if len(when_stack) > len(stack):
                        has_when_val = True
                    when_val = when_stack[-1] if len(when_stack) > len(stack) else 'nil'
                    when_str = indent_code(when_code)
                    if when_val != 'nil':
                        if when_str: when_str += f"\n  {when_val}"
                        else: when_str = f"  {when_val}"

                    case_lines.append(f"when {key}")
                    if when_str:
                        case_lines.append(when_str)

                else_stack = list(stack)
                else_code = translate_range(scan_pc + 1, cases[0][1] - 1, else_stack, pop_final=False) if cases else []
                else_val = else_stack[-1] if len(else_stack) > len(stack) else 'nil'
                else_str = indent_code(else_code)
                if else_val != 'nil':
                    if else_str: else_str += f"\n  {else_val}"
                    else: else_str = f"  {else_val}"

                if else_str:
                    case_lines.append("else")
                    case_lines.append(else_str)
                case_lines.append("end")

                case_block = "\n".join(case_lines)
                is_expr = has_when_val or (len(else_stack) > len(stack))

                if is_expr:
                    stack.append(case_block)
                else:
                    append_statement(case_block)

                pc = after_case_idx - 1

            elif op == 'throw':
                throw_type = int(args.split()[0])
                val = strip_outer_parens(stack.pop() if stack else 'nil')
                if throw_type == 2: # break
                    if val == 'nil':
                        append_statement("break")
                    else:
                        append_statement(f"break {val}")
                elif throw_type == 1: # next
                    if val == 'nil':
                        append_statement("next")
                    else:
                        append_statement(f"next {val}")
                elif throw_type == 0: # re-raise / return
                    if val != 'nil' and '$!' in val:
                        # Auto-generated re-raise in rescue block, skip
                        pass
                    else:
                        if val == 'nil':
                            append_statement("return")
                        else:
                            append_statement(f"return {val}")
                else:
                    append_statement(f"throw {val}")
            elif op in ('branchunless', 'branchif', 'branchnil'):
                cond = strip_outer_parens(stack.pop() if stack else '<empty_cond>')

                # Merge compound branches if possible
                merged_cond, merged_op, merged_target_idx, merged_pc = analyzer.merge_compound_branches(pc, cond, end_idx, append_statement)
                cond = merged_cond
                op = merged_op
                target_idx = merged_target_idx
                pc = merged_pc
                target_offset = iseq.instructions[target_idx]['offset'] if (target_idx is not None and target_idx < len(iseq.instructions)) else 'unknown'

                keyword = "next" if ("block" in iseq.name) else "return"

                if op in ('branchunless', 'branchnil'):
                    # Check for early return in non-jumping path
                    early_ret = analyzer.get_early_return_val(pc + 1, target_idx - 1) if target_idx > pc + 1 else None
                    if early_ret is not None:
                        if early_ret != 'nil':
                            if early_ret.startswith(('raise', 'exit')):
                                append_statement(f"{early_ret} if {cond}")
                            else:
                                append_statement(f"{keyword} {early_ret} if {cond}")
                        else:
                            append_statement(f"{keyword} if {cond}")
                        pc = target_idx - 1
                    elif analyzer.get_simple_return_val(target_idx, cond) is not None:
                        ret_val, ret_offsets = analyzer.get_simple_return_val(target_idx, cond)
                        if ret_val != 'nil':
                            if ret_val.startswith(('raise', 'exit')):
                                append_statement(f"{ret_val} unless {cond}")
                            else:
                                append_statement(f"{keyword} {ret_val} unless {cond}")
                        else:
                            append_statement(f"{keyword} unless {cond}")
                        skipped_offsets.update(ret_offsets)
                    elif target_idx > pc and analyzer.is_early_return_path(pc + 1, target_idx - 1):
                        then_stack = list(stack)
                        then_code = translate_range(pc + 1, target_idx - 1, then_stack, pop_final=False)
                        then_val = then_stack[-1] if len(then_stack) > len(stack) else 'nil'
                        if then_code:
                            then_str = indent_code(then_code)
                            if then_val != 'nil':
                                then_str += f"\n  {keyword} {then_val}"
                            else:
                                then_str += f"\n  {keyword}"
                            append_statement(f"if {cond}\n{then_str}\nend")
                        else:
                            if then_val != 'nil':
                                if then_val.startswith(('raise', 'exit')):
                                    append_statement(f"{then_val} if {cond}")
                                else:
                                    append_statement(f"{keyword} {then_val} if {cond}")
                            else:
                                append_statement(f"{keyword} if {cond}")
                        pc = target_idx - 1
                    elif target_idx > pc:
                        # Forward branch
                        has_else = False
                        else_target_idx = None
                        if target_idx > 0:
                            prev_instr = iseq.instructions[target_idx - 1]
                            if prev_instr['op'] == 'jump':
                                else_target_offset = int(prev_instr['args'].split()[-1])
                                else_target_idx = offset_to_idx[else_target_offset]
                                if else_target_idx >= target_idx and else_target_idx <= end_idx:
                                    has_else = True

                        if has_else:
                            then_stack = list(stack)
                            then_code = translate_range(pc + 1, target_idx - 1, then_stack, pop_final=False)

                            else_stack = list(stack)
                            else_code = translate_range(target_idx, else_target_idx, else_stack, pop_final=False)

                            is_expr = False
                            then_val = 'nil'
                            else_val = 'nil'
                            if len(then_stack) > len(stack) or len(else_stack) > len(stack):
                                is_expr = True
                                merge_idx = else_target_idx if has_else else target_idx
                                if merge_idx is not None:
                                    scan_idx = merge_idx
                                    while scan_idx < len(iseq.instructions):
                                        scan_op = iseq.instructions[scan_idx]['op']
                                        if scan_op == 'nop':
                                            scan_idx += 1
                                            continue
                                        if scan_op == 'pop':
                                            is_expr = False
                                        break
                                if is_expr:
                                    then_val = then_stack[-1] if len(then_stack) > len(stack) else 'nil'
                                    else_val = else_stack[-1] if len(else_stack) > len(stack) else 'nil'

                            if is_expr:
                                if not then_code and not else_code:
                                    stack.append(f"({cond} ? {wrap_if_complex(then_val)} : {wrap_if_complex(else_val)})")
                                else:
                                    then_str = indent_code(then_code)
                                    if then_val != 'nil': then_str += f"\n  {then_val}"
                                    else_str = indent_code(else_code)
                                    if else_val != 'nil': else_str += f"\n  {else_val}"
                                    stack.append(f"if {cond}\n{then_str}\nelse\n{else_str}\nend")
                            else:
                                if len(then_stack) > len(stack):
                                    then_code.append(then_stack.pop())
                                if len(else_stack) > len(stack):
                                    else_code.append(else_stack.pop())
                                then_str = indent_code(then_code)
                                else_str = indent_code(else_code)
                                append_statement(f"if {cond}\nelse\n{else_str}\nend" if not then_str else f"if {cond}\n{then_str}\nelse\n{else_str}\nend")
                            pc = min(else_target_idx, end_idx) - 1
                        else:
                            then_stack = list(stack)
                            recursive_target = min(target_idx, end_idx)
                            then_code = translate_range(pc + 1, recursive_target, then_stack, pop_final=False)

                            is_expr = False
                            then_val = 'nil'
                            else_val = 'nil'
                            if len(then_stack) > len(stack):
                                is_expr = True
                                scan_idx = target_idx
                                while scan_idx < len(iseq.instructions):
                                    scan_op = iseq.instructions[scan_idx]['op']
                                    if scan_op == 'nop':
                                        scan_idx += 1
                                        continue
                                    if scan_op == 'pop':
                                        is_expr = False
                                    break
                                if is_expr:
                                    then_val = then_stack[-1]
                                    else_val = 'nil'
                            elif len(then_stack) == len(stack) and then_stack and then_stack[-1] != stack[-1]:
                                is_expr = True
                                scan_idx = target_idx
                                while scan_idx < len(iseq.instructions):
                                    scan_op = iseq.instructions[scan_idx]['op']
                                    if scan_op == 'nop':
                                        scan_idx += 1
                                        continue
                                    if scan_op == 'pop':
                                        is_expr = False
                                    break
                                if is_expr:
                                    then_val = then_stack[-1]
                                    else_val = stack[-1]

                            if is_expr:
                                if len(then_stack) == len(stack):
                                    stack.pop()
                                    if not then_code:
                                        if op == 'branchnil' or cond == else_val:
                                            stack.append(f"({cond} && {then_val})")
                                        else:
                                            stack.append(f"({cond} ? {then_val} : {else_val})")
                                    else:
                                        then_str = indent_code(then_code)
                                        if then_val != 'nil': then_str += f"\n  {then_val}"
                                        stack.append(f"if {cond}\n{then_str}\nelse\n  {else_val}\nend")
                                else:
                                    then_str = indent_code(then_code)
                                    if then_val != 'nil': then_str += f"\n  {then_val}"
                                    stack.append(f"if {cond}\n{then_str}\nend")
                            else:
                                if len(then_stack) > len(stack):
                                    then_code.append(then_stack.pop())
                                then_str = indent_code(then_code)
                                if then_str:
                                    append_statement(f"if {cond}\n{then_str}\nend")
                            pc = recursive_target - 1
                    else:
                        # Ghi chú an toàn các lệnh nhảy ngược backward branch trong YARV tránh báo lỗi Syntax trong Ruby
                        append_statement(f"# break unless {cond} # backward branch to {target_offset}")

                elif op == 'branchif':
                    # Check for early return in non-jumping path
                    early_ret = analyzer.get_early_return_val(pc + 1, target_idx - 1) if target_idx > pc + 1 else None
                    if early_ret is not None:
                        if early_ret != 'nil':
                            if early_ret.startswith(('raise', 'exit')):
                                append_statement(f"{early_ret} unless {cond}")
                            else:
                                append_statement(f"{keyword} {early_ret} unless {cond}")
                        else:
                            append_statement(f"{keyword} unless {cond}")
                        pc = target_idx - 1
                    elif analyzer.get_simple_return_val(target_idx, cond) is not None:
                        ret_val, ret_offsets = analyzer.get_simple_return_val(target_idx, cond)
                        if ret_val != 'nil':
                            if ret_val.startswith(('raise', 'exit')):
                                append_statement(f"{ret_val} if {cond}")
                            else:
                                append_statement(f"{keyword} {ret_val} if {cond}")
                        else:
                            append_statement(f"{keyword} if {cond}")
                        skipped_offsets.update(ret_offsets)
                    elif target_idx > pc:
                        # Forward branch
                        then_stack = list(stack)
                        recursive_target = min(target_idx, end_idx)
                        then_code = translate_range(pc + 1, recursive_target, then_stack, pop_final=False)

                        is_expr = False
                        then_val = 'nil'
                        else_val = 'nil'
                        if len(then_stack) > len(stack):
                            is_expr = True
                            scan_idx = target_idx
                            while scan_idx < len(iseq.instructions):
                                scan_op = iseq.instructions[scan_idx]['op']
                                if scan_op == 'nop':
                                    scan_idx += 1
                                    continue
                                if scan_op == 'pop':
                                    is_expr = False
                                break
                            if is_expr:
                                then_val = then_stack[-1]
                                else_val = 'nil'
                        elif len(then_stack) == len(stack) and then_stack and then_stack[-1] != stack[-1]:
                            is_expr = True
                            scan_idx = target_idx
                            while scan_idx < len(iseq.instructions):
                                scan_op = iseq.instructions[scan_idx]['op']
                                if scan_op == 'nop':
                                    scan_idx += 1
                                    continue
                                if scan_op == 'pop':
                                    is_expr = False
                                break
                            if is_expr:
                                then_val = then_stack[-1]
                                else_val = stack[-1]

                        if is_expr:
                            if len(then_stack) == len(stack):
                                stack.pop()
                                if not then_code:
                                    if cond == else_val:
                                        stack.append(f"({cond} || {then_val})")
                                    else:
                                        stack.append(f"({cond} ? {else_val} : {then_val})")
                                else:
                                    then_str = indent_code(then_code)
                                    if then_val != 'nil': then_str += f"\n  {then_val}"
                                    stack.append(f"unless {cond}\n{then_str}\nelse\n  {else_val}\nend")
                            else:
                                then_str = indent_code(then_code)
                                if then_val != 'nil': then_str += f"\n  {then_val}"
                                stack.append(f"unless {cond}\n{then_str}\nend")
                        else:
                            if len(then_stack) > len(stack):
                                then_code.append(then_stack.pop())
                            then_str = indent_code(then_code)
                            if then_str:
                                append_statement(f"unless {cond}\n{then_str}\nend")
                        pc = recursive_target - 1
                    else:
                        # Ghi chú an toàn các lệnh nhảy ngược backward branch trong YARV tránh báo lỗi Syntax trong Ruby
                        append_statement(f"# break if {cond} # backward branch to {target_offset}")

            elif op == 'jump':
                try:
                    target_offset = int(args.split()[-1])
                except (ValueError, IndexError):
                    target_offset = None
                if target_offset is not None:
                    target_idx = offset_to_idx.get(target_offset)
                    if target_idx is not None and target_idx > pc:
                        cond_end_idx = target_idx
                        found_loop = False
                        loop_type = None
                        back_idx = None
                        for i in range(target_idx, min(target_idx + 10, len(iseq.instructions))):
                            iop = iseq.instructions[i]['op']
                            if iop in ('branchif', 'branchunless', 'branchnil'):
                                try:
                                    back_target = int(iseq.instructions[i]['args'].split()[-1])
                                except (ValueError, IndexError):
                                    back_target = None
                                b_idx = offset_to_idx.get(back_target)
                                if b_idx is not None and pc < b_idx <= target_idx:
                                    cond_end_idx = i
                                    found_loop = True
                                    loop_type = 'while' if iop == 'branchif' else 'until'
                                    back_idx = b_idx
                                    break
                            elif iop in ('jump', 'leave', 'throw'):
                                break

                        if found_loop:
                            cond_stack = list(stack)
                            translate_range(target_idx, cond_end_idx, cond_stack, pop_final=False)
                            cond = cond_stack.pop() if cond_stack else 'true'

                            body_stack = []
                            body_code = translate_range(back_idx, target_idx, body_stack, pop_final=False)
                            body_str = indent_code(body_code)

                            append_statement(f"{loop_type} {cond}\n{body_str}\nend")
                            pc = cond_end_idx + 1
                            continue

            elif op == 'leave':
                is_block_or_class = ("block" in iseq.name) or iseq.name.startswith("<class:") or iseq.name.startswith("<module:")
                is_early_return = False
                if not is_block_or_class:
                    for j in range(pc + 1, len(iseq.instructions)):
                        if iseq.instructions[j]['op'] not in ('nop', 'leave'):
                            is_early_return = True
                            break

                if stack:
                    ret_val = stack.pop()
                    for orphaned in stack:
                        # Tránh flush các định danh rác vô nghĩa từ stack lên statements khi rời hàm
                        if re.match(r'^(true|false|nil|self|\[\]|\{\})$', orphaned) or \
                           re.match(r'^@{1,2}[a-zA-Z_][a-zA-Z0-9_]*[!?]?$', orphaned) or \
                           re.match(r'^\$[a-zA-Z_][a-zA-Z0-9_]*[!?]?$', orphaned) or \
                           re.match(r'^[a-zA-Z_][a-zA-Z0-9_]*[!?]?$', orphaned) or \
                           re.match(r'^:[a-zA-Z0-9_!?=]+$', orphaned) or \
                           re.match(r'^["\'].*["\']$', orphaned) or \
                           re.match(r'^\-?\d+(\.\d+)?$', orphaned):
                            continue
                        append_statement(orphaned)
                    stack.clear()
                    stack.append(ret_val)

                if stack:
                    val = strip_outer_parens(stack.pop())
                    if val != 'nil':
                        if is_early_return:
                            if val.startswith(('raise', 'exit')):
                                append_statement(val)
                            else:
                                append_statement(f"return {val}")
                        else:
                            is_top_or_class = iseq.name in ("<top (required)>", "<encoded>") or iseq.name.startswith("<class:") or iseq.name.startswith("<module:")
                            if is_top_or_class:
                                if re.match(r'^(true|false|nil|self|\[\]|\{\})$', val) or \
                                   re.match(r'^@{1,2}[a-zA-Z_][a-zA-Z0-9_]*[!?]?$', val) or \
                                   re.match(r'^\$[a-zA-Z_][a-zA-Z0-9_]*[!?]?$', val) or \
                                   re.match(r'^[a-zA-Z_][a-zA-Z0-9_]*[!?]?$', val) or \
                                   re.match(r'^:[a-zA-Z0-9_!?=]+$', val) or \
                                   re.match(r'^["\'].*["\']$', val) or \
                                   re.match(r'^\-?\d+(\.\d+)?$', val):
                                    pass
                                else:
                                    append_statement(val)
                            else:
                                # Kiểm tra xem dòng lệnh cuối có bị trùng lặp return rác hay không
                                already_terminated = statements and is_unconditionally_terminating(statements[-1])
                                if not already_terminated:
                                    is_redundant_return = False
                                    if statements:
                                        last_stmt = statements[-1].strip()
                                        if last_stmt.startswith(f"{val} =") or last_stmt.startswith(f"self.{val} =") or last_stmt == val:
                                            is_redundant_return = True
                                    if not is_redundant_return:
                                        append_statement(val)
                    else:
                        if is_early_return:
                            append_statement("return")
                else:
                    if is_early_return:
                        append_statement("return")

                pc += 1

                if is_root and pc < end_idx:
                    ensure_stack = []
                    ensure_stmts = translate_range(pc, end_idx, ensure_stack, pop_final=True, is_root=False)
                    if ensure_stmts:
                        if is_block_or_class or not statements:
                            statements.extend(ensure_stmts)
                        else:
                            last_stmt = statements[-1] if statements else ''
                            is_dead_code = (
                                re.match(r'^return\b|^raise\b|^exit\b', last_stmt) or
                                re.match(r'^\s*(return|raise|exit)\b', last_stmt.splitlines()[-1] if last_stmt else '')
                            )
                            if is_dead_code:
                                statements.extend(ensure_stmts)
                            else:
                                main_str = indent_code(statements)
                                ensure_str = indent_code(ensure_stmts)
                                statements = [f"begin\n{main_str}\nensure\n{ensure_str}\nend"]

                break

            pc += 1

        if is_root:
            # Dọn dẹp rò rỉ ngăn xếp (stack leaks) ở cuối phạm vi dịch ngược
            # Giữ lại tối đa 1 phần tử (đỉnh stack) làm giá trị trả về của khối lệnh
            while len(stack) > 1:
                val = stack.pop(0)
                if val != 'nil':
                    if not re.match(r'^(true|false|nil|self|\[\]|\{\})$', val) and \
                       not re.match(r'^@{1,2}[a-zA-Z_][a-zA-Z0-9_]*[!?]?$', val) and \
                       not re.match(r'^\$[a-zA-Z_][a-zA-Z0-9_]*[!?]?$', val) and \
                       not re.match(r'^[a-zA-Z_][a-zA-Z0-9_]*[!?]?$', val) and \
                       not re.match(r'^:[a-zA-Z0-9_!?=]+$', val) and \
                       not re.match(r'^["\'].*["\']$', val) and \
                       not re.match(r'^\-?\d+(\.\d+)?$', val):
                        # Áp dụng bộ lọc cho các phép toán và mảng đơn giản
                        if not re.match(r'^\s*\(?[a-zA-Z0-9_@$\[\]\:\.\'\"]+\s*[\+\-\*\/]\s*[a-zA-Z0-9_@$\[\]\:\.\'\"]+\)?\s*$', val) and \
                           not (re.match(r'^\s*[a-zA-Z0-9_@$\[\]\:\.]+(\[[^\]=]+\])+\s*$', val) and '=' not in val):
                            append_statement(val)

            if pop_final and stack:
                val = stack.pop()
                if val != 'nil':
                    if not re.match(r'^(true|false|nil|self|\[\]|\{\})$', val) and \
                       not re.match(r'^@{1,2}[a-zA-Z_][a-zA-Z0-9_]*[!?]?$', val) and \
                       not re.match(r'^\$[a-zA-Z_][a-zA-Z0-9_]*[!?]?$', val) and \
                       not re.match(r'^[a-zA-Z_][a-zA-Z0-9_]*[!?]?$', val) and \
                       not re.match(r'^:[a-zA-Z0-9_!?=]+$', val) and \
                       not re.match(r'^["\'].*["\']$', val) and \
                       not re.match(r'^\-?\d+(\.\d+)?$', val):
                        # Áp dụng bộ lọc cho các phép toán và mảng đơn giản
                        if not re.match(r'^\s*\(?[a-zA-Z0-9_@$\[\]\:\.\'\"]+\s*[\+\-\*\/]\s*[a-zA-Z0-9_@$\[\]\:\.\'\"]+\)?\s*$', val) and \
                           not (re.match(r'^\s*[a-zA-Z0-9_@$\[\]\:\.]+(\[[^\]=]+\])+\s*$', val) and '=' not in val):
                            append_statement(val)
        return statements

    def scan_defaults(iseq):
        skipped_offsets = set()
        defaults = {}
        scan_idx = 0
        while scan_idx < len(iseq.instructions):
            instr = iseq.instructions[scan_idx]
            op = instr['op']
            if op == 'checkkeyword':
                if scan_idx + 1 < len(iseq.instructions):
                    next_instr = iseq.instructions[scan_idx + 1]
                    if next_instr['op'] == 'branchif':
                        try:
                            target_offset = int(next_instr['args'].split()[-1])
                            if target_offset in offset_to_idx:
                                target_idx = offset_to_idx[target_offset]
                                setlocal_idx = target_idx - 1
                                if setlocal_idx > scan_idx + 1:
                                    setlocal_instr = iseq.instructions[setlocal_idx]
                                    if setlocal_instr['op'].startswith('setlocal'):
                                        raw_var_name = setlocal_instr['args'].split('@')[0].strip()
                                        local_idx_match = re.search(r'@(\d+)', setlocal_instr['args'])
                                        local_idx = int(local_idx_match.group(1)) if local_idx_match else scan_idx
                                        var_name = sanitize_ruby_identifier(raw_var_name, local_idx)

                                        # Translate default value expression
                                        sub_stack = []
                                        # Backup resolved_counts to prevent side-effects
                                        saved_counts = resolved_counts.copy()
                                        translate_range(scan_idx + 2, setlocal_idx - 1, sub_stack, pop_final=False)
                                        resolved_counts.clear()
                                        resolved_counts.update(saved_counts)

                                        default_val = sub_stack[-1] if sub_stack else 'nil'
                                        defaults[var_name] = default_val

                                        # Skip checkkeyword and setlocal blocks
                                        for idx in range(scan_idx, target_idx):
                                            skipped_offsets.add(iseq.instructions[idx]['offset'])
                                        scan_idx = target_idx
                                        continue
                        except ValueError:
                            pass
            elif op in ('putnil', 'putobject', 'putstring', 'putobject_INT2FIX_0_', 'putobject_INT2FIX_1_', 'putobject_INT2FIX_0', 'putobject_INT2FIX_1'):
                if scan_idx + 1 < len(iseq.instructions):
                    next_instr = iseq.instructions[scan_idx + 1]
                    if next_instr['op'].startswith('setlocal'):
                        raw_var_name = next_instr['args'].split('@')[0].strip()
                        local_idx_match = re.search(r'@(\d+)', next_instr['args'])
                        local_idx = int(local_idx_match.group(1)) if local_idx_match else scan_idx
                        var_name = sanitize_ruby_identifier(raw_var_name, local_idx)

                        is_opt_param = False
                        for p in iseq.locals.values():
                            if p['name'] == var_name and p['tag'] and p['tag'].startswith('Opt='):
                                is_opt_param = True
                                break
                        if is_opt_param:
                            if op == 'putnil':
                                defaults[var_name] = 'nil'
                            elif op in ('putobject_INT2FIX_0_', 'putobject_INT2FIX_0'):
                                defaults[var_name] = '0'
                            elif op in ('putobject_INT2FIX_1_', 'putobject_INT2FIX_1'):
                                defaults[var_name] = '1'
                            else:
                                defaults[var_name] = instr['args'].strip()
                            skipped_offsets.add(instr['offset'])
                            skipped_offsets.add(next_instr['offset'])
                            scan_idx += 2
                            continue
            break
        return skipped_offsets, defaults

    skipped_offsets, defaults = scan_defaults(iseq)
    res = translate_range(0, len(iseq.instructions), [], is_root=True)
    code = "\n".join(res)

    return code
