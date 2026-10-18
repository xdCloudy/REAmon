class TranslationContext:
    def __init__(self, iseq, all_iseqs):
        self.iseq = iseq
        self.all_iseqs = all_iseqs
        self.offset_to_idx = {instr['offset']: idx for idx, instr in enumerate(iseq.instructions)}
        self.resolved_counts = {}

        self.is_block_or_class = ("block" in iseq.name) or iseq.name.startswith("<class:") or iseq.name.startswith("<module:")
        self.is_class_or_module = iseq.name.startswith("<class:") or iseq.name.startswith("<module:")

        # Precompute static child mappings to avoid dynamic state / lookahead side effects
        self.child_matches = {}
        for child in iseq.children:
            self.child_matches.setdefault(child.name, []).append(child)

        self.child_counts = {}
        self.pc_to_child = {}
        for idx, instr in enumerate(iseq.instructions):
            op = instr['op']
            args = instr['args']
            child_name = None
            if op == 'defineclass':
                parts = args.split(', ')
                if len(parts) >= 2:
                    child_name = parts[1].strip()
            elif op in ('definemethod', 'definesmethod'):
                parts = args.split(', ')
                if len(parts) >= 2:
                    child_name = parts[1].strip()
            elif op == 'send':
                parts = args.split(', ')
                block_name = parts[-1].strip()
                if block_name in self.child_matches:
                    child_name = block_name

            if child_name:
                matches = self.child_matches.get(child_name, [])
                count = self.child_counts.get(child_name, 0)
                self.child_counts[child_name] = count + 1
                if count < len(matches):
                    self.pc_to_child[idx] = matches[count]
                else:
                    self.pc_to_child[idx] = all_iseqs.get(child_name)

        # Pre-scan for backward branches to identify loop headers
        self.backward_branches = {} # start_idx -> list of branch_idx
        for idx, instr in enumerate(iseq.instructions):
            op = instr['op']
            if op in ('branchif', 'branchunless', 'branchnil', 'jump'):
                try:
                    target_offset = int(instr['args'].split()[-1])
                    target_idx = self.offset_to_idx.get(target_offset)
                    if target_idx is not None and target_idx < idx:
                        self.backward_branches.setdefault(target_idx, []).append(idx)
                except (ValueError, IndexError):
                    pass

    def resolve_child(self, name, pc=None):
        if pc is not None and pc in self.pc_to_child:
            return self.pc_to_child[pc]
        count = self.resolved_counts.get(name, 0)
        self.resolved_counts[name] = count + 1
        matches = [c for c in self.iseq.children if c.name == name]
        if count < len(matches):
            return matches[count]
        return self.all_iseqs.get(name)
