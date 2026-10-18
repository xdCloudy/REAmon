package main

import (
	"bytes"
	"compress/zlib"
	"io"
	"math/rand"
)

const (
	maxEntryBytes = 32 << 20
	maxArchiveEntries = 20000
)

const (
	PYINST20_COOKIE_SIZE = 24      // For pyinstaller 2.0
	PYINST21_COOKIE_SIZE = 24 + 64 // For pyinstaller 2.1+
)

var PYINST_MAGIC [8]byte = [8]byte{'M', 'E', 'I', 014, 013, 012, 013, 016} // Magic number which identifies pyinstaller

type PyInst20Cookie struct {
	Magic           []byte `struct:"[8]byte"`
	LengthOfPackage int    `struct:"int32,big"`
	Toc             int    `struct:"int32,big"`
	TocLen          int    `struct:"int32,big"`
	PythonVersion   int    `struct:"int32,big"`
}

type PyInst21Cookie struct {
	Magic           []byte `struct:"[8]byte"`
	LengthOfPackage uint   `struct:"uint32,big"`
	Toc             uint   `struct:"uint32,big"`
	TocLen          int    `struct:"int32,big"`
	PythonVersion   int    `struct:"int32,big"`
	PythonLibName   []byte `struct:"[64]byte"`
}

type CTOCEntry struct {
	EntrySize            int  `struct:"int32,big"`
	EntryPosition        uint `struct:"uint32,big"`
	DataSize             uint `struct:"uint32,big"`
	UncompressedDataSize uint `struct:"uint32,big"`
	ComressionFlag       int8 `struct:"int8"`
	TypeCompressedData   byte `struct:"byte"`
	Name                 string
}

func zlibDecompress(in []byte) (out []byte, err error) {
	var zr io.ReadCloser
	zr, err = zlib.NewReader(bytes.NewReader(in))
	if err != nil {
		return
	}
	defer zr.Close()
	out, err = io.ReadAll(io.LimitReader(zr, maxEntryBytes+1))
	if err == nil && len(out) > maxEntryBytes {
		return nil, io.ErrShortBuffer
	}
	return
}

func randomString() string {
	const CHARSET = "0123456789abcdef"
	var randomBytes []byte = make([]byte, 16)

	for i := 0; i < 16; i++ {
		randomBytes[i] = CHARSET[rand.Intn(len(CHARSET))]
	}
	return string(randomBytes)
}
