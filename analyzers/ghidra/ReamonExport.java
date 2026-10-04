import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.symbol.Reference;
import java.util.HashSet;
import java.util.Set;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;

public class ReamonExport extends GhidraScript {
    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 3) {
            throw new IllegalArgumentException("Expected export directory, function limit, and call-edge limit");
        }

        Path exportRoot = Path.of(args[0]).toAbsolutePath().normalize();
        int maxFunctions = Integer.parseInt(args[1]);
        int maxCallEdges = Integer.parseInt(args[2]);
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
                String code = result.getDecompiledFunction().getC();
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
                String assemblyFilename = String.format("%06d_%s.asm", decompiled, safeAddress);
                Path assembly = exportRoot.resolve("assembly").resolve(assemblyFilename).normalize();
                if (!assembly.startsWith(exportRoot.resolve("assembly").normalize())) {
                    throw new IllegalStateException("Function assembly path escaped export directory");
                }
                StringBuilder listing = new StringBuilder();
                InstructionIterator instructions = currentProgram.getListing().getInstructions(function.getBody(), true);
                while (instructions.hasNext()) {
                    monitor.checkCancelled();
                    Instruction instruction = instructions.next();
                    listing.append(instruction.getAddress()).append(": ").append(instruction).append('\n');
                    Reference[] references = currentProgram.getReferenceManager().getReferencesFrom(instruction.getAddress());
                    for (Reference reference : references) {
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
                String relativePath = "functions/" + filename;
                String assemblyRelativePath = "assembly/" + assemblyFilename;
                String line = encodedName + "\t" + address + "\t" + sizeBytes + "\t" + relativePath + "\t" + assemblyRelativePath + "\n";
                Files.writeString(manifest, line, StandardCharsets.UTF_8,
                    java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
                decompiled++;
            }
        } finally {
            decompiler.dispose();
        }

        Files.writeString(calls, callManifest.toString(), StandardCharsets.UTF_8);
        Files.writeString(summary,
            "visited=" + visited + "\n" +
            "decompiled=" + decompiled + "\n" +
            "failed=" + failed + "\n" +
            "truncated=" + truncated + "\n" +
            "callCount=" + callCount + "\n" +
            "callsTruncated=" + callsTruncated + "\n",
            StandardCharsets.UTF_8);
    }
}
