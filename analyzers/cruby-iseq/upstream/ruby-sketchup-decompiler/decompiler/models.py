"""
Data models for decompiler
"""

class ISeq:
    def __init__(self, name, filepath, start_line, end_line):
        self.name = name
        self.filepath = filepath
        self.start_line = start_line
        self.end_line = end_line
        self.local_table = {} # idx -> name
        self.args = [] # names of arguments in order
        self.instructions = [] # list of dict: {offset, op, args, raw_line}
        self.catch_table = []
        self.children = []
        self.parent = None
        self.argc = 0
        self.opts = 0
        self.rest = -1
        self.post = 0
        self.block = -1
        self.kw_num = 0
        self.kwrest = -1
        self.locals = {} # idx -> {'name': name, 'tag': tag}
        self.has_catch_table = False

    def __repr__(self):
        return f"<ISeq {self.name} {self.filepath}:{self.start_line}-{self.end_line}>"
