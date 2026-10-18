import re
from .models import ISeq
from .utils import get_nesting_level, sanitize_ruby_identifier

def parse_dump(file_path):
    iseqs = []
    iseq_by_name = {}

    with open(file_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    iseq_stack = [] # chứa các ISeq đang hoạt động ở từng cấp độ lồng nhau
    last_instr = None

    header_re = re.compile(r'== disasm: #<ISeq:(.*?)@(.*):(\d+)')
    instr_re = re.compile(r'^\s*(?:\|\s*)*(\d{4})\s+(\w+)\s*(.*)$')

    for line in lines:
        clean_line = re.sub(r'^(?:\|\s*)+', '', line).strip()
        if not clean_line:
            continue

        level = get_nesting_level(line)

        # Kiểm tra ISeq mới
        m = header_re.search(clean_line)
        if m:
            name = m.group(1).strip()
            filepath = m.group(2).strip()
            start_line = int(m.group(3))

            current_iseq = ISeq(name, filepath, start_line, start_line)
            iseqs.append(current_iseq)
            iseq_by_name[name] = current_iseq

            # Cập nhật iseq stack
            iseq_stack = iseq_stack[:level]
            if iseq_stack:
                current_iseq.parent = iseq_stack[-1]
                iseq_stack[-1].children.append(current_iseq)
            iseq_stack.append(current_iseq)
            continue

        if clean_line == '== catch table':
            iseq_stack = iseq_stack[:level+1]
            if iseq_stack:
                iseq_stack[-1].has_catch_table = True
            continue

        m_catch = re.match(r'^catch type:\s+(\w+)\s+st:\s+(\d+)\s+ed:\s+(\d+)\s+sp:\s+(\d+)\s+cont:\s+(\d+)', clean_line)
        if m_catch:
            iseq_stack = iseq_stack[:level]
            if iseq_stack:
                iseq_stack[-1].catch_table.append({
                    'type': m_catch.group(1),
                    'st': int(m_catch.group(2)),
                    'ed': int(m_catch.group(3)),
                    'sp': int(m_catch.group(4)),
                    'cont': int(m_catch.group(5))
                })
            continue


        iseq_stack = iseq_stack[:level+1]
        if level >= len(iseq_stack):
            continue

        current_iseq = iseq_stack[level]

        # Phân tích local table header
        m_lt = re.match(
            r'^local table\s*\(\s*size:\s*\d+,\s*argc:\s*(\d+)\s*\[\s*opts:\s*(\d+),\s*rest:\s*(-?\d+),\s*post:\s*(\d+),\s*block:\s*(-?\d+),\s*kw:\s*(-?\d+)(?:@(-?\d+))?,\s*kwrest:\s*(-?\d+)\s*\]\s*\)',
            clean_line
        )
        if m_lt:
            current_iseq.argc = int(m_lt.group(1))
            current_iseq.opts = int(m_lt.group(2))
            current_iseq.rest = int(m_lt.group(3))
            current_iseq.post = int(m_lt.group(4))
            current_iseq.block = int(m_lt.group(5))
            current_iseq.kw_num = int(m_lt.group(6))
            current_iseq.kwrest = int(m_lt.group(8))
            continue

        # Phân tích các biến trong local table
        matches = re.findall(r'\[\s*\d+\]\s+([^@\s<]+)@(\d+)(?:<([^>]+)>)?', clean_line)
        if matches and clean_line.startswith('['):
            for raw_var_name, idx_str, tag in matches:
                local_idx = int(idx_str)
                # Áp dụng bộ lọc tên biến hợp lệ cho Ruby
                var_name = sanitize_ruby_identifier(raw_var_name, local_idx)
                tag_str = tag.strip() if tag else ""
                current_iseq.locals[local_idx] = {'name': var_name, 'tag': tag_str}
                current_iseq.local_table[local_idx] = var_name
                if tag_str == 'Arg':
                    current_iseq.args.append(var_name)
            continue

        # Phân tích các lệnh bytecode
        m_instr = instr_re.match(line)
        if m_instr:
            if last_instr is not None:
                # Làm sạch args của instruction trước đó
                a_str = last_instr['args']
                a_str = re.sub(r'\s*\(\s*\d+\)\[(?:[A-Z][a-z])+\]\s*$', '', a_str)
                a_str = re.sub(r'\s*\[(?:[A-Z][a-z])+\]\s*$', '', a_str)
                a_str = re.sub(r'\s*\(\s*\d+\)\s*$', '', a_str)
                last_instr['args'] = a_str.strip()

            offset = int(m_instr.group(1))
            op = m_instr.group(2)
            args_str = m_instr.group(3)

            new_instr = {
                'offset': offset,
                'op': op,
                'args': args_str,
                'raw': line.strip()
            }
            current_iseq.instructions.append(new_instr)
            last_instr = new_instr
            continue

        # Gộp các dòng multiline (như regex nhiều dòng)
        if last_instr is not None:
            if not (clean_line.startswith('[DUMPER]') or clean_line.startswith('==') or clean_line.startswith('---') or clean_line.startswith('catch type:')):
                last_instr['args'] += "\n" + clean_line
                continue

    if last_instr is not None:
        a_str = last_instr['args']
        a_str = re.sub(r'\s*\(\s*\d+\)\[(?:[A-Z][a-z])+\]\s*$', '', a_str)
        a_str = re.sub(r'\s*\[(?:[A-Z][a-z])+\]\s*$', '', a_str)
        a_str = re.sub(r'\s*\(\s*\d+\)\s*$', '', a_str)
        last_instr['args'] = a_str.strip()

    return iseqs, iseq_by_name
