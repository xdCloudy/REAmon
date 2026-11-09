package main

import "testing"

func TestSupportedCArchiveTypecodes(t *testing.T) {
	for _, typecode := range []byte{'b', 'd', 'z', 'Z', 'M', 'm', 's', 'x', 'o', 'l', 'n'} {
		if !supportedCArchiveTypecode(typecode) {
			t.Errorf("valid CArchive typecode %q was rejected", typecode)
		}
	}

	for _, typecode := range []byte{'?', 0, 'a', '\n'} {
		if supportedCArchiveTypecode(typecode) {
			t.Errorf("unknown CArchive typecode %q was accepted", typecode)
		}
	}
}
