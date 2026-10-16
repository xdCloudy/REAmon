import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.ClangNode;
import ghidra.app.decompiler.ClangStatement;
import ghidra.app.decompiler.ClangToken;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Data;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.data.DataType;
import ghidra.program.model.pcode.HighFunction;
import ghidra.program.model.pcode.HighSymbol;
import ghidra.program.model.pcode.HighVariable;
import ghidra.program.model.pcode.LocalSymbolMap;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.pcode.PcodeOp;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;

public class ReamonExport extends GhidraScript {
    private static final int MAX_SOURCE_ADDRESS_MAPPINGS = 5000;
    private static final int MAX_RECOVERED_VARIABLES = 10000;
    private static final int MAX_VARIABLES_PER_FUNCTION = 100;
    private int sourceAddressMappingCount = 0;
    private int recoveredVariableCount = 0;
    private boolean sourceAddressMapTruncated = false;
    private boolean recoveredVariablesTruncated = false;
    private boolean currentVariablesTruncated = false;

    private String encodeValue(String value) {
        return Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private String collectRecoveredVariables(HighFunction function) {
        currentVariablesTruncated = false;
        if (function == null) return "";
        LocalSymbolMap symbols = function.getLocalSymbolMap();
        if (symbols == null) return "";
        java.util.Iterator<HighSymbol> iterator = symbols.getSymbols();
        StringBuilder output = new StringBuilder();
        int functionVariableCount = 0;
        while (iterator.hasNext()) {
            HighSymbol symbol = iterator.next();
            if (functionVariableCount >= MAX_VARIABLES_PER_FUNCTION || recoveredVariableCount >= MAX_RECOVERED_VARIABLES) {
                currentVariablesTruncated = true;
                recoveredVariablesTruncated = true;
                break;
            }
            HighVariable variable = symbol.getHighVariable();
            if (variable == null) continue;
            boolean parameter = symbol.isParameter();
            int parameterIndex = parameter ? symbol.getCategoryIndex() : -1;
            String name = symbol.getName() == null ? "" : symbol.getName().trim();
            DataType dataType = symbol.getDataType();
            String typeName = dataType == null ? "" : dataType.getDisplayName();
            if (name.isEmpty()) continue;
            if (name.length() > 256) name = name.substring(0, 256);
            if (typeName != null && typeName.length() > 256) typeName = typeName.substring(0, 256);
            if (typeName == null) typeName = "";
            ghidra.program.model.address.Address firstUse = symbol.getPCAddress();
            output.append(parameter ? "parameter" : "local").append('\t')
                .append(parameterIndex).append('\t')
                .append(Math.max(0, symbol.getSize())).append('\t')
                .append(firstUse == null ? "" : firstUse.toString()).append('\t')
                .append(encodeValue(name)).append('\t')
                .append(encodeValue(typeName)).append('\n');
            functionVariableCount++;
            recoveredVariableCount++;
        }
        if (iterator.hasNext()) {
            currentVariablesTruncated = true;
            recoveredVariablesTruncated = true;
        }
        return Base64.getEncoder().encodeToString(output.toString().getBytes(StandardCharsets.UTF_8));
    }

    private void collectLineNumbers(ClangNode node, ClangStatement owner, Set<Integer> lines) {
        if (node != owner && node instanceof ClangStatement) return;
        if (node instanceof ClangToken) {
            ClangToken token = (ClangToken) node;
            if (token.getLineParent() != null) lines.add(token.getLineParent().getLineNumber());
        }
        for (int index = 0; index < node.numChildren(); index++) {
            collectLineNumbers(node.Child(index), owner, lines);
        }
    }

    private void collectStatementMappings(ClangNode node, StringBuilder output, Set<String> seen) {
        if (node == null) return;
        if (sourceAddressMappingCount >= MAX_SOURCE_ADDRESS_MAPPINGS) {
            sourceAddressMapTruncated = true;
            return;
        }
        if (node instanceof ClangStatement) {
            ClangStatement statement = (ClangStatement) node;
            PcodeOp operation = statement.getPcodeOp();
            if (operation != null) {
                String address = operation.getSeqnum().getTarget().toString();
                Set<Integer> lines = new LinkedHashSet<>();
                collectLineNumbers(statement, statement, lines);
                for (Integer lineNumber : lines) {
                    String mapping = lineNumber + "\t" + address;
                    if (seen.add(mapping) && sourceAddressMappingCount < MAX_SOURCE_ADDRESS_MAPPINGS) {
                        output.append(mapping).append('\n');
                        sourceAddressMappingCount++;
                    }
                }
            }
        }
        for (int index = 0; index < node.numChildren(); index++) {
            collectStatementMappings(node.Child(index), output, seen);
        }
    }

    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 3) {
            throw new IllegalArgumentException("Expected export directory, function limit, and call-edge limit");
        }

        Path exportRoot = Path.of(args[0]).toAbsolutePath().normalize();
        int maxFunctions = Integer.parseInt(args[1]);
        int maxCallEdges = Integer.parseInt(args[2]);
        int maxSignatureInstructions = 800;
        Files.createDirectories(exportRoot.resolve("functions"));
        Files.createDirectories(exportRoot.resolve("assembly"));
        Path manifest = exportRoot.resolve("manifest.tsv");
        Path summary = exportRoot.resolve("summary.txt");
        Path calls = exportRoot.resolve("calls.tsv");
        Files.deleteIfExists(manifest);
        Files.deleteIfExists(calls);

        DecompInterface decompiler = new DecompInterface();
        decompiler.setOptions(new DecompileOptions());
        if (!decompiler.openProgram(currentProgram)) {
            throw new IllegalStateException("Ghidra could not open the imported program for decompilation");
        }

        int visited = 0;
        int decompiled = 0;
        int failed = 0;
        boolean truncated = false;
        boolean callsTruncated = false;
        int callCount = 0;
        Set<String> seenCalls = new HashSet<>();
        StringBuilder callManifest = new StringBuilder();
        try {
            FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
            while (functions.hasNext()) {
                monitor.checkCancelled();
                if (visited >= maxFunctions) {
                    truncated = true;
                    break;
                }
                Function function = functions.next();
                visited++;
                DecompileResults result = decompiler.decompileFunction(function, 20, monitor);
                if (!result.decompileCompleted() || result.getDecompiledFunction() == null) {
                    failed++;
                    continue;
                }
                ghidra.app.decompiler.DecompiledFunction decompiledFunction = result.getDecompiledFunction();
                String code = decompiledFunction.getC();
                if (code == null || code.isBlank()) {
                    failed++;
                    continue;
                }

                String address = function.getEntryPoint().toString();
                String safeAddress = address.replaceAll("[^A-Za-z0-9_-]", "_");
                String filename = String.format("%06d_%s.c", decompiled, safeAddress);
                Path source = exportRoot.resolve("functions").resolve(filename).normalize();
                if (!source.startsWith(exportRoot.resolve("functions").normalize())) {
                    throw new IllegalStateException("Function source path escaped export directory");
                }
                Files.writeString(source, code, StandardCharsets.UTF_8);
                StringBuilder sourceAddressMap = new StringBuilder();
                collectStatementMappings(result.getCCodeMarkup(), sourceAddressMap, new HashSet<>());
                String assemblyFilename = String.format("%06d_%s.asm", decompiled, safeAddress);
                Path assembly = exportRoot.resolve("assembly").resolve(assemblyFilename).normalize();
                if (!assembly.startsWith(exportRoot.resolve("assembly").normalize())) {
                    throw new IllegalStateException("Function assembly path escaped export directory");
                }
                StringBuilder listing = new StringBuilder();
                StringBuilder mnemonicSequence = new StringBuilder();
                int mnemonicCount = 0;
                Set<String> referencedStrings = new LinkedHashSet<>();
                InstructionIterator instructions = currentProgram.getListing().getInstructions(function.getBody(), true);
                while (instructions.hasNext()) {
                    monitor.checkCancelled();
                    Instruction instruction = instructions.next();
                    listing.append(instruction.getAddress()).append(": ").append(instruction).append('\n');
                    if (mnemonicCount < maxSignatureInstructions) {
                        mnemonicSequence.append(instruction.getMnemonicString().toLowerCase(java.util.Locale.ROOT)).append('\n');
                        mnemonicCount++;
                    }
                    Reference[] references = currentProgram.getReferenceManager().getReferencesFrom(instruction.getAddress());
                    for (Reference reference : references) {
                        Data targetData = currentProgram.getListing().getDataContaining(reference.getToAddress());
                        if (targetData != null && targetData.hasStringValue()) {
                            String value = StringDataInstance.getStringDataInstance(targetData).getStringValue();
                            if (value != null && !value.isBlank() && value.length() <= 512 && referencedStrings.size() < 12) {
                                referencedStrings.add(value);
                            }
                        }
                        if (!reference.getReferenceType().isCall()) continue;
                        String targetAddress = reference.getToAddress().toString();
                        String edgeKey = address + "\t" + targetAddress;
                        if (!seenCalls.add(edgeKey)) continue;
                        if (callCount >= maxCallEdges) {
                            callsTruncated = true;
                            continue;
                        }
                        Function target = currentProgram.getFunctionManager().getFunctionAt(reference.getToAddress());
                        String targetName = target != null ? target.getName() : "sub_" + targetAddress;
                        String encodedSourceName = Base64.getEncoder().encodeToString(function.getName().getBytes(StandardCharsets.UTF_8));
                        String encodedTargetName = Base64.getEncoder().encodeToString(targetName.getBytes(StandardCharsets.UTF_8));
                        callManifest.append(address).append('\t').append(targetAddress).append('\t')
                            .append(encodedSourceName).append('\t').append(encodedTargetName).append('\n');
                        callCount++;
                    }
                }
                Files.writeString(assembly, listing, StandardCharsets.UTF_8);
                long sizeBytes = Math.max(1L, function.getBody().getNumAddresses());
                String encodedName = Base64.getEncoder().encodeToString(function.getName().getBytes(StandardCharsets.UTF_8));
                StringBuilder stringManifest = new StringBuilder();
                for (String value : referencedStrings) {
                    if (stringManifest.length() > 0) stringManifest.append(',');
                    stringManifest.append(Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8)));
                }
                String encodedStrings = Base64.getEncoder().encodeToString(stringManifest.toString().getBytes(StandardCharsets.UTF_8));
                String encodedMnemonics = Base64.getEncoder().encodeToString(mnemonicSequence.toString().getBytes(StandardCharsets.UTF_8));
                String encodedSourceAddressMap = Base64.getEncoder().encodeToString(sourceAddressMap.toString().getBytes(StandardCharsets.UTF_8));
                String prototype = decompiledFunction.getSignature();
                String encodedPrototype = Base64.getEncoder().encodeToString(
                    (prototype == null ? "" : prototype.substring(0, Math.min(2000, prototype.length()))).getBytes(StandardCharsets.UTF_8));
                String encodedVariables = collectRecoveredVariables(result.getHighFunction());
                String relativePath = "functions/" + filename;
                String assemblyRelativePath = "assembly/" + assemblyFilename;
                String line = encodedName + "\t" + address + "\t" + sizeBytes + "\t" + relativePath + "\t" + assemblyRelativePath + "\t" + encodedStrings + "\t" + encodedMnemonics + "\t" + encodedSourceAddressMap + "\t" + encodedPrototype + "\t" + encodedVariables + "\t" + currentVariablesTruncated + "\n";
                Files.writeString(manifest, line, StandardCharsets.UTF_8,
                    java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
                decompiled++;
            }
        } finally {
            decompiler.dispose();
        }

        Files.writeString(calls, callManifest.toString(), StandardCharsets.UTF_8);
        Files.writeString(summary,
            "instructionArchitecture=" + currentProgram.getLanguageID().toString() + "\n" +
            "visited=" + visited + "\n" +
            "decompiled=" + decompiled + "\n" +
            "failed=" + failed + "\n" +
            "truncated=" + truncated + "\n" +
            "callCount=" + callCount + "\n" +
            "callsTruncated=" + callsTruncated + "\n" +
            "sourceAddressMapTruncated=" + sourceAddressMapTruncated + "\n" +
            "recoveredVariablesTruncated=" + recoveredVariablesTruncated + "\n",
            StandardCharsets.UTF_8);
    }
}
