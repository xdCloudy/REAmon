import unittest,server
class Tests(unittest.TestCase):
 def test_scanner_skips_nested_comments_and_strings(self):
  self.assertEqual(len(server.funcs('(module (; (func $fake) ;) (data (i32.const 0) "x ) (func)") (func $real))')),1)
if __name__=='__main__':unittest.main()
