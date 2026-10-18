//go:build !gopherjs

package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"pyinstxtractor-go/marshal"

	"github.com/go-restruct/restruct"
	// "github.com/k0kubun/pp/v3"
)

type PyInstArchive struct {
	inFilePath              string
	fPtr                    io.ReadSeekCloser
	fileSize                int64
	cookiePosition          int64
	pyInstVersion           int64
	pythonMajorVersion      int
	pythonMinorVersion      int
	overlaySize             int64
	overlayPosition         int64
	tableOfContentsSize     int64
	tableOfContentsPosition int64
	tableOfContents         []CTOCEntry
	pycMagic                [4]byte
	gotPycMagic             bool
	barePycsList            []string
}

func (p *PyInstArchive) Open() bool {
	var err error
	if p.fPtr, err = os.Open(p.inFilePath); err != nil {
		fmt.Printf("[!] Couldn't open %s\n", p.inFilePath)
		return false
	}
	var fileInfo os.FileInfo
	if fileInfo, err = os.Stat(p.inFilePath); err != nil {
		fmt.Printf("[!] Couldn't get size of file %s\n", p.inFilePath)
		return false
	}
	p.fileSize = fileInfo.Size()
	return true
}

func (p *PyInstArchive) Close() {
	p.fPtr.Close()
}

func (p *PyInstArchive) CheckFile() bool {
	fmt.Printf("[+] Processing %s\n", p.inFilePath)

	var searchChunkSize int64 = 8192
	endPosition := p.fileSize
	p.cookiePosition = -1

	if endPosition < int64(len(PYINST_MAGIC)) {
		fmt.Println("[!] Error : File is too short or truncated")
		return false
	}

	var startPosition, chunkSize int64
	for {
		if endPosition >= searchChunkSize {
			startPosition = endPosition - searchChunkSize
		} else {
			startPosition = 0
		}
		chunkSize = endPosition - startPosition
		if chunkSize < int64(len(PYINST_MAGIC)) {
			break
		}

		if _, err := p.fPtr.Seek(startPosition, io.SeekStart); err != nil {
			fmt.Println("[!] File seek failed")
			return false
		}
		var data []byte = make([]byte, searchChunkSize)
		p.fPtr.Read(data)

		if offs := bytes.Index(data, PYINST_MAGIC[:]); offs != -1 {
			p.cookiePosition = startPosition + int64(offs)
			break
		}
		endPosition = startPosition + int64(len(PYINST_MAGIC)) - 1

		if startPosition == 0 {
			break
		}
	}
	if p.cookiePosition == -1 {
		fmt.Println("[!] Error : Missing cookie, unsupported pyinstaller version or not a pyinstaller archive")
		return false
	}
	p.fPtr.Seek(p.cookiePosition+PYINST20_COOKIE_SIZE, io.SeekStart)

	var cookie []byte = make([]byte, 64)
	if _, err := p.fPtr.Read(cookie); err != nil {
		fmt.Println("[!] Failed to read cookie!")
		return false
	}

	cookie = bytes.ToLower(cookie)
	if bytes.Contains(cookie, []byte("python")) {
		p.pyInstVersion = 21
		fmt.Println("[+] Pyinstaller version: 2.1+")
	} else {
		p.pyInstVersion = 20
		fmt.Println("[+] Pyinstaller version: 2.0")
	}
	return true
}

func (p *PyInstArchive) GetCArchiveInfo() bool {
	failFunc := func() bool {
		fmt.Println("[!] Error : The file is not a pyinstaller archive")
		return false
	}

	getPyMajMinVersion := func(version int) (int, int) {
		if version >= 100 {
			return version / 100, version % 100
		}
		return version / 10, version % 10
	}

	printPythonVerLenPkg := func(pyMajVer, pyMinVer int, lenPkg uint) {
		fmt.Printf("[+] Python version: %d.%d\n", pyMajVer, pyMinVer)
		fmt.Printf("[+] Length of package: %d bytes\n", lenPkg)
	}

	calculateTocPosition := func(cookieSize int, lengthOfPackage, toc uint, tocLen int) {
		// Additional data after the cookie
		tailBytes := p.fileSize - p.cookiePosition - int64(cookieSize)

		// Overlay is the data appended at the end of the PE
		p.overlaySize = int64(lengthOfPackage) + tailBytes
		p.overlayPosition = p.fileSize - p.overlaySize
		p.tableOfContentsPosition = p.overlayPosition + int64(toc)
		p.tableOfContentsSize = int64(tocLen)
	}

	if _, err := p.fPtr.Seek(p.cookiePosition, io.SeekStart); err != nil {
		return failFunc()
	}

	if p.pyInstVersion == 20 {
		var pyInst20Cookie PyInst20Cookie
		cookieBuf := make([]byte, PYINST20_COOKIE_SIZE)
		if _, err := p.fPtr.Read(cookieBuf); err != nil {
			return failFunc()
		}

		if err := restruct.Unpack(cookieBuf, binary.LittleEndian, &pyInst20Cookie); err != nil {
			return failFunc()
		}

		p.pythonMajorVersion, p.pythonMinorVersion = getPyMajMinVersion(pyInst20Cookie.PythonVersion)
		printPythonVerLenPkg(p.pythonMajorVersion, p.pythonMinorVersion, uint(pyInst20Cookie.LengthOfPackage))

		calculateTocPosition(
			PYINST20_COOKIE_SIZE,
			uint(pyInst20Cookie.LengthOfPackage),
			uint(pyInst20Cookie.Toc),
			pyInst20Cookie.TocLen,
		)

	} else {
		var pyInst21Cookie PyInst21Cookie
		cookieBuf := make([]byte, PYINST21_COOKIE_SIZE)
		if _, err := p.fPtr.Read(cookieBuf); err != nil {
			return failFunc()
		}
		if err := restruct.Unpack(cookieBuf, binary.LittleEndian, &pyInst21Cookie); err != nil {
			return failFunc()
		}
		fmt.Println("[+] Python library file:", string(bytes.Trim(pyInst21Cookie.PythonLibName, "\x00")))
		p.pythonMajorVersion, p.pythonMinorVersion = getPyMajMinVersion(pyInst21Cookie.PythonVersion)
		printPythonVerLenPkg(p.pythonMajorVersion, p.pythonMinorVersion, pyInst21Cookie.LengthOfPackage)

		calculateTocPosition(
			PYINST21_COOKIE_SIZE,
			pyInst21Cookie.LengthOfPackage,
			pyInst21Cookie.Toc,
			pyInst21Cookie.TocLen,
		)
	}
	if p.overlayPosition < 0 || p.overlaySize <= 0 || p.overlayPosition > p.fileSize || p.overlaySize > p.fileSize-p.overlayPosition {
		return failFunc()
	}
	if p.tableOfContentsPosition < p.overlayPosition || p.tableOfContentsSize <= 0 || p.tableOfContentsSize > p.overlaySize {
		return failFunc()
	}
	if p.tableOfContentsPosition > p.overlayPosition+p.overlaySize-p.tableOfContentsSize {
		return failFunc()
	}
	return true
}

func (p *PyInstArchive) ParseTOC() bool {
	const CTOCEntryStructSize = 18
	if p.tableOfContentsSize <= 0 || p.tableOfContentsSize > 64<<20 || p.tableOfContentsPosition < 0 || p.tableOfContentsPosition > p.fileSize || p.tableOfContentsSize > p.fileSize-p.tableOfContentsPosition {
		return false
	}
	if _, err := p.fPtr.Seek(p.tableOfContentsPosition, io.SeekStart); err != nil {
		return false
	}

	var parsedLen int64 = 0

	// Parse table of contents
	for parsedLen < p.tableOfContentsSize {
		if len(p.tableOfContents) >= maxArchiveEntries || p.tableOfContentsSize-parsedLen < CTOCEntryStructSize {
			return false
		}
		var ctocEntry CTOCEntry

		data := make([]byte, CTOCEntryStructSize)
		if _, err := io.ReadFull(p.fPtr, data); err != nil || restruct.Unpack(data, binary.LittleEndian, &ctocEntry) != nil {
			return false
		}
		if ctocEntry.EntrySize < CTOCEntryStructSize || int64(ctocEntry.EntrySize) > p.tableOfContentsSize-parsedLen {
			return false
		}
		if uint64(ctocEntry.DataSize) > maxEntryBytes || uint64(ctocEntry.EntryPosition) > uint64(p.overlaySize) || uint64(ctocEntry.DataSize) > uint64(p.overlaySize)-uint64(ctocEntry.EntryPosition) {
			return false
		}

		if ctocEntry.EntrySize-CTOCEntryStructSize > 4096 {
			return false
		}
		nameBuffer := make([]byte, ctocEntry.EntrySize-CTOCEntryStructSize)
		if _, err := io.ReadFull(p.fPtr, nameBuffer); err != nil {
			return false
		}

		nameBuffer = bytes.TrimRight(nameBuffer, "\x00")
		if len(nameBuffer) == 0 {
			ctocEntry.Name = randomString()
			fmt.Printf("[!] Warning: Found an unamed file in CArchive. Using random name %s\n", ctocEntry.Name)
		} else {
			ctocEntry.Name = string(nameBuffer)
		}

		// fmt.Printf("%+v\n", ctocEntry)
		p.tableOfContents = append(p.tableOfContents, ctocEntry)
		parsedLen += int64(ctocEntry.EntrySize)
	}
	fmt.Printf("[+] Found %d files in CArchive\n", len(p.tableOfContents))
	return parsedLen == p.tableOfContentsSize
}

func safeArchivePath(value string) string {
	value = strings.Trim(value, "\x00")
	value = strings.ReplaceAll(value, "\\", string(os.PathSeparator))
	value = strings.ReplaceAll(value, "/", string(os.PathSeparator))
	if value == "" || filepath.IsAbs(value) || filepath.VolumeName(value) != "" {
		return ""
	}
	cleaned := filepath.Clean(value)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(os.PathSeparator)) {
		return ""
	}
	return cleaned
}

func (p *PyInstArchive) ensureUnique(fileName, ext string) string {
	_, err := os.Stat(fileName + ext)
	if err == nil {
		// File exists
		newName := fileName + "_" + randomString()
		fmt.Printf("[!] Warning: %s already exists, saving as %s\n", fileName+ext, newName+ext)
		return newName
	}
	return fileName
}

func (p *PyInstArchive) ExtractFiles() bool {
	fmt.Println("[+] Beginning extraction...please standby")
	cwd, _ := os.Getwd()

	extractionDir := filepath.Join(cwd, filepath.Base(p.inFilePath)+"_extracted")
	if err := os.Mkdir(extractionDir, 0755); err != nil && !os.IsExist(err) {
		return false
	}
	if err := os.Chdir(extractionDir); err != nil {
		return false
	}

	var totalBytes uint64
	for _, entry := range p.tableOfContents {
		entry.Name = safeArchivePath(entry.Name)
		if entry.Name == "" {
			continue
		}
		if _, err := p.fPtr.Seek(p.overlayPosition+int64(entry.EntryPosition), io.SeekStart); err != nil {
			return false
		}
		data := make([]byte, entry.DataSize)
		if _, err := io.ReadFull(p.fPtr, data); err != nil {
			return false
		}

		if entry.ComressionFlag == 1 {
			var err error
			compressedData := data[:]
			data, err = zlibDecompress(compressedData)
			if err != nil {
				fmt.Printf("[!] Error: Failed to decompress %s in CArchive\n", entry.Name)
				return false
			}

			if uint(len(data)) != entry.UncompressedDataSize {
				fmt.Printf("[!] Warning: Decompressed size mismatch for file %s\n", entry.Name)
			}
		}

		totalBytes += uint64(len(data))
		if totalBytes > 128<<20 {
			return false
		}

		if entry.TypeCompressedData == 'd' || entry.TypeCompressedData == 'o' {
			// d -> ARCHIVE_ITEM_DEPENDENCY
			// o -> ARCHIVE_ITEM_RUNTIME_OPTION
			// These are runtime options, not files
			continue
		}

		basePath := filepath.Dir(entry.Name)
		if basePath != "." {
			if _, err := os.Stat(basePath); os.IsNotExist(err) {
				os.MkdirAll(basePath, 0755)
			}
		}
		switch entry.TypeCompressedData {
		case 's':
			// s -> ARCHIVE_ITEM_PYSOURCE
			// Entry point are expected to be python scripts
			fmt.Printf("[+] Possible entry point: %s.pyc\n", entry.Name)
			entry.Name = p.ensureUnique(entry.Name, ".pyc")
			if !p.gotPycMagic {
				// if we don't have the pyc header yet, fix them in a later pass
				p.barePycsList = append(p.barePycsList, entry.Name+".pyc")
			}
			p.writePyc(entry.Name+".pyc", data)
		case 'M', 'm':
			// M -> ARCHIVE_ITEM_PYPACKAGE
			// m -> ARCHIVE_ITEM_PYMODULE
			// packages and modules are pyc files with their header intact

			// From PyInstaller 5.3 and above pyc headers are no longer stored
			// https://github.com/pyinstaller/pyinstaller/commit/a97fdf

			entry.Name = p.ensureUnique(entry.Name, ".pyc")

			if len(data) < 4 {
				return false
			}
			if data[2] == '\r' && data[3] == '\n' {
				// < pyinstaller 5.3
				if !p.gotPycMagic {
					copy(p.pycMagic[:], data[0:4])
					p.gotPycMagic = true
				}
				p.writeRawData(entry.Name+".pyc", data)
			} else {
				// >= pyinstaller 5.3
				if !p.gotPycMagic {
					// if we don't have the pyc header yet, fix them in a later pass
					p.barePycsList = append(p.barePycsList, entry.Name+".pyc")
				}
				p.writePyc(entry.Name+".pyc", data)
			}
		default:
			entry.Name = p.ensureUnique(entry.Name, "")
			p.writeRawData(entry.Name, data)

			if entry.TypeCompressedData == 'z' || entry.TypeCompressedData == 'Z' {
				if p.pythonMajorVersion == 3 {
					p.extractPYZ(entry.Name)
				} else {
					fmt.Printf("[!] Skipping pyz extraction as Python %d.%d is not supported\n", p.pythonMajorVersion, p.pythonMinorVersion)
				}
			}
		}
	}
	p.fixBarePycs()
	return true
}

func (p *PyInstArchive) fixBarePycs() {
	for _, pycFile := range p.barePycsList {
		f, err := os.OpenFile(pycFile, os.O_RDWR, 0666)
		if err != nil {
			fmt.Printf("[!] Failed to fix header of file %s\n", pycFile)
			continue
		}
		f.Write(p.pycMagic[:])
		f.Close()
	}
}

func (p *PyInstArchive) extractPYZ(path string) {
	dirName := path + "_extracted"
	if _, err := os.Stat(dirName); os.IsNotExist(err) {
		os.MkdirAll(dirName, 0755)
	}

	f, err := os.Open(path)
	if err != nil {
		fmt.Println("[!] Failed to extract pyz", err)
		return
	}
	info, err := f.Stat()
	if err != nil || info.Size() < 12 {
		f.Close()
		return
	}
	var pyzMagic []byte = make([]byte, 4)
	if _, err := io.ReadFull(f, pyzMagic); err != nil {
		f.Close()
		return
	}
	if !bytes.Equal(pyzMagic, []byte("PYZ\x00")) {
		fmt.Println("[!] Magic header in PYZ archive doesn't match")
	}

	var pyzPycMagic []byte = make([]byte, 4)
	if _, err := io.ReadFull(f, pyzPycMagic); err != nil {
		f.Close()
		return
	}

	if !p.gotPycMagic {
		copy(p.pycMagic[:], pyzPycMagic)
		p.gotPycMagic = true
	} else if !bytes.Equal(p.pycMagic[:], pyzPycMagic) {
		copy(p.pycMagic[:], pyzPycMagic)
		p.gotPycMagic = true
		fmt.Println("[!] Warning: pyc magic of files inside PYZ archive are different from those in CArchive")
	}

	var pyzTocPositionBytes []byte = make([]byte, 4)
	if _, err := io.ReadFull(f, pyzTocPositionBytes); err != nil {
		f.Close()
		return
	}
	pyzTocPosition := binary.BigEndian.Uint32(pyzTocPositionBytes)
	if uint64(pyzTocPosition) > uint64(info.Size()) {
		f.Close()
		return
	}
	if _, err := f.Seek(int64(pyzTocPosition), io.SeekStart); err != nil {
		f.Close()
		return
	}

	su := marshal.NewUnmarshaler(f)
	obj := su.Unmarshal()
	if obj == nil {
		fmt.Println("Unmarshalling failed")
	} else {
		// pp.Print(obj)
		listobj := obj.(*marshal.PyListObject)
		listobjItems := listobj.GetItems()
		if len(listobjItems) > maxArchiveEntries {
			listobjItems = listobjItems[:maxArchiveEntries]
		}
		fmt.Printf("[+] Found %d files in PYZArchive\n", len(listobjItems))

		var pyzTotalBytes uint64
		for _, item := range listobjItems {
			item := item.(*marshal.PyListObject)
			name := item.GetItems()[0].(*marshal.PyStringObject).GetString()

			ispkg_position_length_tuple := item.GetItems()[1].(*marshal.PyListObject)
			ispkg := ispkg_position_length_tuple.GetItems()[0].(*marshal.PyIntegerObject).GetValue()
			position := ispkg_position_length_tuple.GetItems()[1].(*marshal.PyIntegerObject).GetValue()
			length := ispkg_position_length_tuple.GetItems()[2].(*marshal.PyIntegerObject).GetValue()

			// Prevent writing outside dirName
			filename := strings.ReplaceAll(name, "..", "__")
			filename = strings.ReplaceAll(filename, ".", string(os.PathSeparator))

			var filenamepath string
			if ispkg == 1 {
				filenamepath = filepath.Join(dirName, filename, "__init__.pyc")
			} else {
				filenamepath = filepath.Join(dirName, filename+".pyc")
			}

			filenamepath = safeArchivePath(filenamepath)
			if filenamepath == "" {
				continue
			}
			fileDir := filepath.Dir(filenamepath)
			if fileDir != "." {
				if _, err := os.Stat(fileDir); os.IsNotExist(err) {
					os.MkdirAll(fileDir, 0755)
				}
			}

			if position < 0 || length <= 0 || length > maxEntryBytes || int64(position) > info.Size() || int64(length) > info.Size()-int64(position) {
				continue
			}
			if _, err := f.Seek(int64(position), io.SeekStart); err != nil {
				continue
			}
			var compressedData []byte = make([]byte, length)
			if _, err := io.ReadFull(f, compressedData); err != nil {
				continue
			}

			decompressedData, err := zlibDecompress(compressedData)
			if err != nil {
				continue
			}
			pyzTotalBytes += uint64(len(decompressedData))
			if pyzTotalBytes > 128<<20 {
				break
			}
			p.writePyc(filenamepath, decompressedData)
		}
	}
	f.Close()
}

func (p *PyInstArchive) writePyc(path string, data []byte) {
	path = safeArchivePath(path)
	if path == "" || len(data) > maxEntryBytes {
		return
	}
	f, err := os.Create(path)
	if err != nil {
		fmt.Printf("[!] Failed to write file %s\n", path)
		return
	}
	// pyc magic
	f.Write(p.pycMagic[:])

	if p.pythonMajorVersion >= 3 && p.pythonMinorVersion >= 7 {
		// PEP 552 -- Deterministic pycs
		f.Write([]byte{0, 0, 0, 0})             //Bitfield
		f.Write([]byte{0, 0, 0, 0, 0, 0, 0, 0}) //(Timestamp + size) || hash
	} else {
		f.Write([]byte{0, 0, 0, 0}) //Timestamp
		if p.pythonMajorVersion >= 3 && p.pythonMinorVersion >= 3 {
			f.Write([]byte{0, 0, 0, 0})
		}
	}
	f.Write(data)
}

func (p *PyInstArchive) writeRawData(path string, data []byte) {
	path = safeArchivePath(path)
	if path == "" || len(data) > maxEntryBytes {
		return
	}

	dir := filepath.Dir(path)
	if dir != "." {
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			os.MkdirAll(dir, 0755)
		}
	}
	os.WriteFile(path, data, 0666)
}

func extract_exe(fileName string) (ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	arch := PyInstArchive{inFilePath: fileName}

	if arch.Open() {
		if arch.CheckFile() {
			if arch.GetCArchiveInfo() {
				if !arch.ParseTOC() || !arch.ExtractFiles() {
					arch.Close()
					return false
				}
				fmt.Printf("[+] Successfully extracted pyinstaller archive: %s\n", fileName)
				fmt.Println("\nYou can now use a python decompiler on the pyc files within the extracted directory")
				arch.Close()
				return true
			}
		}
		arch.Close()
	}
	return false
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("[+] Usage pyinstxtractor-ng <filename>')")
		return
	}
	if !extract_exe(os.Args[1]) {
		os.Exit(1)
	}
}
