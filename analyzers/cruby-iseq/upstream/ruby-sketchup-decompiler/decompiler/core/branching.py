class BranchAnalyzer:
    def __init__(self, context, translate_range_fn):
        self.ctx = context
        self.translate_range = translate_range_fn

    def get_simple_return_val(self, target_idx, cond=None):
        if self.ctx.is_class_or_module:
            return None
        if target_idx < 0 or target_idx >= len(self.ctx.iseq.instructions):
            return None
        scan_idx = target_idx
        block_instrs = []
        has_setn = False
        while scan_idx < len(self.ctx.iseq.instructions):
            instr = self.ctx.iseq.instructions[scan_idx]
            op = instr['op']
            if op in ('jump', 'branchif', 'branchunless', 'branchnil', 'opt_case_dispatch', 'newhash', 'newarray', 'duparray', 'duphash'):
                return None
            if op == 'invokeblock' or (op in ('send', 'opt_send_without_block', 'invokesuper') and 'block:' in instr['args']):
                return None
            if op == 'setn':
                has_setn = True

            block_instrs.append(instr)
            if op == 'leave':
                break
            scan_idx += 1
            if len(block_instrs) > 4:
                return None
        if not block_instrs or block_instrs[-1]['op'] != 'leave':
            return None

        if has_setn and cond:
            offsets = [instr['offset'] for instr in block_instrs]
            return cond, offsets

        saved_counts = self.ctx.resolved_counts.copy()
        sub_stack = []
        self.translate_range(target_idx, target_idx + len(block_instrs) - 1, sub_stack, pop_final=False)
        self.ctx.resolved_counts.clear()
        self.ctx.resolved_counts.update(saved_counts)

        offsets = [instr['offset'] for instr in block_instrs]
        if sub_stack:
            return sub_stack[-1], offsets
        return 'nil', offsets

    def get_early_return_val(self, start_idx, end_idx):
        if self.ctx.is_class_or_module:
            return None
        if start_idx > end_idx or start_idx < 0 or end_idx >= len(self.ctx.iseq.instructions):
            return None
        scan_idx = start_idx
        block_instrs = []
        while scan_idx <= end_idx:
            instr = self.ctx.iseq.instructions[scan_idx]
            op = instr['op']
            if op in ('jump', 'branchif', 'branchunless', 'branchnil', 'opt_case_dispatch', 'newhash', 'newarray', 'duparray', 'duphash'):
                return None
            if op == 'invokeblock' or (op in ('send', 'opt_send_without_block', 'invokesuper') and 'block:' in instr['args']):
                return None

            block_instrs.append(instr)
            if op == 'leave':
                if scan_idx == end_idx:
                    break
                else:
                    return None
            scan_idx += 1
            if len(block_instrs) > 4:
                return None
        if not block_instrs or block_instrs[-1]['op'] != 'leave':
            return None

        saved_counts = self.ctx.resolved_counts.copy()
        sub_stack = []
        self.translate_range(start_idx, end_idx, sub_stack, pop_final=False)
        self.ctx.resolved_counts.clear()
        self.ctx.resolved_counts.update(saved_counts)

        if sub_stack:
            return sub_stack[-1]
        return 'nil'

    def is_early_return_path(self, start_idx, end_idx):
        if self.ctx.is_class_or_module:
            return False
        if start_idx > end_idx or start_idx < 0 or end_idx >= len(self.ctx.iseq.instructions):
            return False
        scan_idx = start_idx
        while scan_idx <= end_idx:
            instr = self.ctx.iseq.instructions[scan_idx]
            op = instr['op']
            if op in ('jump', 'branchif', 'branchunless', 'branchnil', 'opt_case_dispatch', 'newhash', 'newarray', 'duparray', 'duphash'):
                return False
            if op == 'leave':
                return scan_idx == end_idx
            scan_idx += 1
        return False

    def merge_compound_branches(self, start_pc, start_cond, end_idx, append_statement):
        current_pc = start_pc
        current_cond = start_cond

        instr = self.ctx.iseq.instructions[current_pc]
        current_op = instr['op']
        current_target_offset = int(instr['args'].split()[-1])
        current_target_idx = self.ctx.offset_to_idx.get(current_target_offset)
        if current_target_idx is None:
            return current_cond, current_op, current_target_idx, current_pc

        while True:
            inner_pc = -1
            for idx in range(current_pc + 1, min(current_target_idx, end_idx)):
                if self.ctx.iseq.instructions[idx]['op'] in ('branchif', 'branchunless', 'branchnil'):
                    inner_pc = idx
                    break

            if inner_pc == -1:
                break

            inner_instr = self.ctx.iseq.instructions[inner_pc]
            inner_op = inner_instr['op']
            inner_target_offset = int(inner_instr['args'].split()[-1])
            inner_target_idx = self.ctx.offset_to_idx.get(inner_target_offset)
            if inner_target_idx is None:
                break

            is_fallthrough = True
            for idx in range(inner_pc + 1, current_target_idx):
                if self.ctx.iseq.instructions[idx]['op'] != 'nop':
                    is_fallthrough = False
                    break

            merge_match = False
            operator = ""
            new_op = ""
            new_target = -1
            new_pc = -1

            if current_op == 'branchif' and inner_op == 'branchunless' and is_fallthrough:
                merge_match = True
                operator = "||"
                new_op = "branchunless"
                new_target = inner_target_idx
                new_pc = current_target_idx - 1
            elif current_op == 'branchunless' and inner_op == 'branchunless' and current_target_idx == inner_target_idx:
                merge_match = True
                operator = "&&"
                new_op = "branchunless"
                new_target = current_target_idx
                new_pc = inner_pc
            elif current_op == 'branchunless' and inner_op == 'branchif' and is_fallthrough:
                merge_match = True
                operator = "&&"
                new_op = "branchif"
                new_target = inner_target_idx
                new_pc = inner_pc
            elif current_op == 'branchif' and inner_op == 'branchif' and current_target_idx == inner_target_idx:
                merge_match = True
                operator = "||"
                new_op = "branchif"
                new_target = current_target_idx
                new_pc = inner_pc

            if merge_match and new_pc > current_pc:
                inner_stack = []
                setup_stmts = self.translate_range(current_pc + 1, inner_pc, inner_stack, pop_final=False)
                for stmt in setup_stmts:
                    append_statement(stmt)
                cond2 = inner_stack[-1] if inner_stack else '<empty_cond>'

                current_cond = f"({current_cond} {operator} {cond2})"
                current_op = new_op
                current_target_idx = new_target
                current_pc = new_pc
            else:
                break

        return current_cond, current_op, current_target_idx, current_pc
