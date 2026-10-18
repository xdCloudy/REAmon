from ..utils import strip_outer_parens, negate_expression

def handle_simple_op(op, args, stack, append_statement):
    if op == 'dummy': pass
    elif op == 'opt_plus':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            # Tối ưu: Bóc ngoặc ở vế trái nếu an toàn (không chứa toán tử ưu tiên thấp hơn)
            # Giúp tránh tình trạng ((a + b) + c) -> (a + b + c)
            lhs_clean = strip_outer_parens(lhs)
            if not any(op_in in lhs_clean for op_in in [' == ', ' != ', ' && ', ' || ', ' ? ', ' .. ']):
                lhs = lhs_clean
            stack.append(f"({lhs} + {rhs})")
    elif op == 'opt_minus':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            lhs_clean = strip_outer_parens(lhs)
            if not any(op_in in lhs_clean for op_in in [' == ', ' != ', ' && ', ' || ', ' ? ', ' .. ']):
                lhs = lhs_clean
            stack.append(f"({lhs} - {rhs})")
    elif op == 'opt_div':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            lhs_clean = strip_outer_parens(lhs)
            if not any(op_in in lhs_clean for op_in in [' + ', ' - ', ' == ', ' != ', ' && ', ' || ', ' ? ', ' .. ']):
                lhs = lhs_clean
            stack.append(f"({lhs} / {rhs})")
    elif op == 'opt_mult':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            lhs_clean = strip_outer_parens(lhs)
            if not any(op_in in lhs_clean for op_in in [' + ', ' - ', ' == ', ' != ', ' && ', ' || ', ' ? ', ' .. ']):
                lhs = lhs_clean
            stack.append(f"({lhs} * {rhs})")
    elif op == 'opt_mod':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            lhs_clean = strip_outer_parens(lhs)
            if not any(op_in in lhs_clean for op_in in [' + ', ' - ', ' == ', ' != ', ' && ', ' || ', ' ? ', ' .. ']):
                lhs = lhs_clean
            stack.append(f"({lhs} % {rhs})")
    elif op == 'opt_ltlt':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            stack.append(f"{lhs} << {rhs}")
    elif op == 'opt_gtgt':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            stack.append(f"{lhs} >> {rhs}")
    elif op == 'opt_and':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            stack.append(f"({lhs} & {rhs})")
    elif op == 'opt_or':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            stack.append(f"({lhs} | {rhs})")
    elif op == 'opt_xor':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            stack.append(f"({lhs} ^ {rhs})")
    elif op == 'opt_empty_p':
        if stack:
            recv = stack.pop()
            stack.append(f"{recv}.empty?")
    elif op == 'opt_nil_p':
        if stack:
            val = stack.pop()
            stack.append(f"{val}.nil?")
    elif op == 'opt_length':
        if stack:
            recv = stack.pop()
            stack.append(f"{recv}.length")
    elif op == 'opt_size':
        if stack:
            recv = stack.pop()
            stack.append(f"{recv}.size")
    elif op == 'newrange':
        flag = int(args.split()[0])
        if len(stack) >= 2:
            high = stack.pop()
            low = stack.pop()
            op_range = '...' if flag == 1 else '..'
            stack.append(f"({strip_outer_parens(low)}{op_range}{strip_outer_parens(high)})")
    elif op in ('opt_newarray_max', 'opt_newarray_min'):
        n = int(args.strip())
        elems = []
        for _ in range(n):
            if stack:
                elems.append(stack.pop())
        elems.reverse()
        suffix = 'max' if op == 'opt_newarray_max' else 'min'
        stack.append(f"[{', '.join(elems)}].{suffix}")
    elif op == 'opt_eq':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            stack.append(f"({lhs} == {rhs})")
    elif op == 'opt_ge':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            stack.append(f"({lhs} >= {rhs})")
    elif op == 'opt_le':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            stack.append(f"({lhs} <= {rhs})")
    elif op == 'opt_neq':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            stack.append(f"({lhs} != {rhs})")
    elif op == 'opt_lt':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            stack.append(f"({lhs} < {rhs})")
    elif op == 'opt_gt':
        if len(stack) >= 2:
            rhs = stack.pop()
            lhs = stack.pop()
            stack.append(f"({lhs} > {rhs})")
    elif op == 'opt_not':
        if stack:
            val = stack.pop()
            # Sử dụng cấu trúc negate_expression thông minh để chuẩn hóa !(!(x)) -> !!(x)
            stack.append(negate_expression(val))
    elif op == 'opt_aref':
        if len(stack) >= 2:
            idx = stack.pop()
            recv = stack.pop()
            stack.append(f"{recv}[{idx}]")
    elif op == 'opt_aset':
        if len(stack) >= 3:
            val = stack.pop()
            idx = stack.pop()
            recv = stack.pop()
            append_statement(f"{recv}[{idx}] = {strip_outer_parens(val)}")
    elif op == 'opt_aset_with':
        parts = args.split(', ')
        key = parts[0].strip()
        if len(stack) >= 2:
            val = stack.pop()
            recv = stack.pop()
            append_statement(f"{recv}[{key}] = {strip_outer_parens(val)}")
    else:
        return False
    return True
