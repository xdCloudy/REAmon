import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;

public class ReamonExport extends GhidraScript {
    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 2) {
            throw new IllegalArgumentException("Expected export directory and function limit");
        }

        Path exportRoot = Path.of(args[0]).toAbsolutePath().normalize();
        int maxFunctions = Integer.parseInt(args[1]);
        Files.createDirectories(exportRoot.resolve("functions"));
        Files.createDirectories(exportRoot.resolve("assembly"));
        Path manifest = exportRoot.resolve("manifest.tsv");
        Path summary = exportRoot.resolve("summary.txt");
        Files.deleteIfExists(manifest);

        DecompInterface decompiler = new DecompInterface();
        decompiler.setOptions(new DecompileOptions());
        if (!decompiler.openProgram(currentProgram)) {
            throw new IllegalStateException("Ghidra could not open the imported program for decompilation");
        }

        int visited = 0;
        int decompiled = 0;
        int failed = 0;
        boolean truncated = false;
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

        Files.writeString(summary,
            "visited=" + visited + "\n" +
            "decompiled=" + decompiled + "\n" +
            "failed=" + failed + "\n" +
            "truncated=" + truncated + "\n",
            StandardCharsets.UTF_8);
    }
}
