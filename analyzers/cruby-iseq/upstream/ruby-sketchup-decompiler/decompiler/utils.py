import re
import os

def get_nesting_level(line):
    m = re.match(r'^(\s*\|\s*)*', line)
    if m:
        prefix = m.group(0)
        return prefix.count('|')
    return 0

def sanitize_ruby_identifier(name, idx):
    """
    Khử độc tên biến cục bộ từ bytecode để đảm bảo cú pháp Ruby hợp lệ.
    Đặc biệt xử lý trường hợp tên biến chứa các ký tự đặc biệt như '?' hoặc số đứng đầu.
    """
    if not name:
        return f"var_{idx}"
    if name == '?':
        return f"var_{idx}"

    # Thay thế các ký tự không hợp lệ bằng dấu gạch dưới
    cleaned = re.sub(r'[^a-zA-Z0-9_]', '_', name)
    # Nếu ký tự đầu là số hoặc in hoa (Ruby coi hằng số bắt đầu bằng chữ in hoa)
    if cleaned[0].isdigit():
        cleaned = f"var_{cleaned}"
    elif cleaned[0].isupper():
        cleaned = cleaned.lower()

    if not re.match(r'^[a-z_][a-zA-Z0-9_]*$', cleaned):
        return f"var_{idx}"
    return cleaned

def can_strip_parens(s):
    if not isinstance(s, str):
        return False
    s = s.strip()
    if not (s.startswith('(') and s.endswith(')')):
        return False
    depth = 0
    for i, char in enumerate(s):
        if char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
            if depth == 0:
                return i == len(s) - 1
    return False

def strip_outer_parens(s):
    if not isinstance(s, str):
        return s
    s_stripped = s.strip()
    while can_strip_parens(s_stripped):
        s_stripped = s_stripped[1:-1].strip()
    return s_stripped

def get_put_value(instr):
    op = instr['op']
    args = instr['args']
    if op in ('putobject_INT2FIX_0_', 'putobject_INT2FIX_0'):
        return '0'
    elif op in ('putobject_INT2FIX_1_', 'putobject_INT2FIX_1'):
        return '1'
    elif op == 'putnil':
        return 'nil'
    elif op in ('putobject', 'putstring', 'duparray', 'duphash'):
        return args.strip()
    return None

def get_method_args(iseq, defaults=None):
    if defaults is None:
        defaults = {}
    if not iseq.locals:
        return iseq.args

    args_list = []

    for i in range(iseq.argc):
        if i in iseq.locals:
            args_list.append(iseq.locals[i]['name'])

    for i in range(iseq.argc, iseq.argc + iseq.opts):
        if i in iseq.locals:
            name = iseq.locals[i]['name']
            default_val = defaults.get(name, 'nil')
            args_list.append(f"{name} = {default_val}")

    if iseq.rest != -1:
        if iiseq_rest := iseq.locals.get(iseq.rest):
            args_list.append(f"*{iiseq_rest['name']}")

    for i in range(iseq.argc + iseq.opts + (1 if iseq.rest != -1 else 0),
                   iseq.argc + iseq.opts + (1 if iseq.rest != -1 else 0) + iseq.post):
        if i in iseq.locals:
            args_list.append(iseq.locals[i]['name'])

    kw_start = iseq.argc + iseq.opts + (1 if iseq.rest != -1 else 0) + iseq.post
    for i in range(kw_start, kw_start + iseq.kw_num):
        if i in iseq.locals:
            name = iseq.locals[i]['name']
            default_val = defaults.get(name, 'nil')
            args_list.append(f"{name}: {default_val}")

    if iseq.kwrest != -1:
        if iiseq_kwrest := iseq.locals.get(iseq.kwrest):
            args_list.append(f"**{iiseq_kwrest['name']}")

    if iseq.block != -1:
        if iiseq_block := iseq.locals.get(iseq.block):
            args_list.append(f"&{iiseq_block['name']}")

    return args_list

def wrap_if_complex(val):
    """
    Bọc ngoặc các biểu thức rẽ nhánh/lồng nhau phức tạp để tránh lỗi cú pháp toán tử 3 ngôi.
    """
    if not val:
        return "nil"
    if '\n' in val or re.match(r'^\s*(if|unless|case|begin|class|module|def)\b', val):
        return f"({val})"
    return val

def negate_expression(expr):
    """
    Tối ưu hóa các biểu thức phủ định để tránh sinh ra !(!(x)) và chuyển đổi thành !!(x).
    Đồng thời giảm thiểu tối đa các cặp ngoặc thừa khi lặp phủ định.
    """
    if expr.startswith('!!(') and expr.endswith(')'):
        return f"!({expr[3:-1]})"
    elif expr.startswith('!(') and expr.endswith(')'):
        return f"!!({expr[2:-1]})"
    else:
        return f"!({expr})"

def get_line_num(instr):
    raw = instr.get('raw', '')
    m = re.search(r'\(\s*(\d+)\)', raw)
    if m:
        return int(m.group(1))
    return None

def is_unconditionally_terminating(stmt):
    """
    Kiểm tra xem câu lệnh Ruby có chấm dứt luồng thực thi vô điều kiện hay không
    (tránh phát sinh code rác hoặc code chết phía sau trong khối lệnh).
    """
    stmt = stmt.strip()
    if not stmt:
        return False
    lines = stmt.splitlines()
    last_line = lines[-1].strip()
    if re.search(r'\s+(if|unless)\s+', last_line):
        return False
    if re.match(r'^(return|raise|exit|break|next)\b', last_line):
        return True
    return False
