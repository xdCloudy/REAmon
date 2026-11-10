package main

import (
	"encoding/binary"
	"os"
	"testing"
)

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

func TestParseTOCRejectsUnknownTypecodeAfterValidEntries(t *testing.T) {
	for _, testCase := range []struct {
		name         string
		invalidIndex int
	}{
		{name: "second_entry", invalidIndex: 1},
		{name: "third_entry", invalidIndex: 2},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			entries := []struct {
				name     string
				typecode byte
			}{
				{name: "first.pyc", typecode: 'm'},
				{name: "second.pyc", typecode: 'm'},
				{name: "third.pyc", typecode: 'm'},
			}
			entries[testCase.invalidIndex].typecode = '?'

			var toc []byte
			for _, entry := range entries {
				encoded := make([]byte, 18+len(entry.name))
				binary.BigEndian.PutUint32(encoded[0:4], uint32(len(encoded)))
				encoded[17] = entry.typecode
				copy(encoded[18:], entry.name)
				toc = append(toc, encoded...)
			}

			file, err := os.CreateTemp(t.TempDir(), "toc-*.bin")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := file.Write(toc); err != nil {
				file.Close()
				t.Fatal(err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}

			archive := PyInstArchive{
				tableOfContentsPosition: 0,
				tableOfContentsSize:     int64(len(toc)),
				fileSize:                int64(len(toc)),
				overlaySize:             1,
			}
			archive.fPtr, err = os.Open(file.Name())
			if err != nil {
				t.Fatal(err)
			}
			defer archive.Close()

			if archive.ParseTOC() {
				t.Fatal("ParseTOC accepted an unknown typecode after valid entries")
			}
			if got := len(archive.tableOfContents); got != testCase.invalidIndex {
				t.Fatalf("parsed %d entries before the invalid entry; want %d", got, testCase.invalidIndex)
			}
		})
	}
}

func TestParseTOCRejectsEmbeddedNULInNameAfterValidEntry(t *testing.T) {
	entries := []struct {
		name string
	}{
		{name: "first.pyc\x00\x00"},
		{name: "bad\x00name\x00"},
	}
	var toc []byte
	for _, entry := range entries {
		encoded := make([]byte, 18+len(entry.name))
		binary.BigEndian.PutUint32(encoded[0:4], uint32(len(encoded)))
		encoded[17] = 'm'
		copy(encoded[18:], entry.name)
		toc = append(toc, encoded...)
	}

	file, err := os.CreateTemp(t.TempDir(), "toc-*.bin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(toc); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	archive := PyInstArchive{
		tableOfContentsPosition: 0,
		tableOfContentsSize:     int64(len(toc)),
		fileSize:                int64(len(toc)),
		overlaySize:             1,
	}
	archive.fPtr, err = os.Open(file.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()

	if archive.ParseTOC() {
		t.Fatal("ParseTOC accepted an embedded NUL in an entry name")
	}
	if got := len(archive.tableOfContents); got != 1 {
		t.Fatalf("parsed %d entries before the invalid entry; want 1", got)
	}
	if got := archive.tableOfContents[0].Name; got != "first.pyc" {
		t.Fatalf("valid NUL-padded entry name = %q; want %q", got, "first.pyc")
	}
}
