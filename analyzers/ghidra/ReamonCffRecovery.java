import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.util.exception.CancelledException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** Read-only adapter for the MIT-licensed Ghidra Deobfuscation Lab CFF engine. */
public class ReamonCffRecovery extends GhidraScript {
    private static final int MAX_NODES_PER_FUNCTION = 32;
    private static final int MAX_EDGES_PER_FUNCTION = 48;
    private static final int MAX_RECOVERED_FUNCTIONS = 64;

    private String quote(String value) {
        if (value == null) return "null";
        StringBuilder result = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char character = value.charAt(i);
            switch (character) {
                case '\\': result.append("\\\\"); break;
                case '"': result.append("\\\""); break;
                case '\n': result.append("\\n"); break;
                case '\r': result.append("\\r"); break;
                case '\t': result.append("\\t"); break;
                default:
                    if (character < 0x20) result.append(String.format("\\u%04x", (int) character));
                    else result.append(character);
            }
        }
        return result.append('"').toString();
    }

    private String recoveryJson(CffCore.Detect detection, CffCore.Recovery recovery) {
        List<Address> heads = new ArrayList<>(recovery.nodes.keySet());
        Collections.sort(heads);
        boolean truncated = heads.size() > MAX_NODES_PER_FUNCTION;
        StringBuilder nodes = new StringBuilder();
        int edgeCount = 0;
        int writtenNodes = 0;
        for (Address head : heads) {
            if (writtenNodes >= MAX_NODES_PER_FUNCTION) break;
            CffCore.Node node = recovery.nodes.get(head);
            if (node == null) continue;
            if (writtenNodes > 0) nodes.append(',');
            nodes.append("{\"head\":").append(quote(head.toString()))
                .append(",\"status\":").append(quote(node.status))
                .append(",\"pure\":").append(node.pure)
                .append(",\"complete\":").append(node.complete)
                .append(",\"selfLoop\":").append(node.selfLoop)
                .append(",\"successors\":[");
            int successorCount = Math.min(node.succs.size(), MAX_EDGES_PER_FUNCTION - edgeCount);
            if (successorCount < node.succs.size()) truncated = true;
            for (int index = 0; index < successorCount; index++) {
                if (index > 0) nodes.append(',');
                nodes.append(quote(node.succs.get(index).toString()));
                edgeCount++;
            }
            nodes.append(']');
            if (node.status.equals("cond")) {
                nodes.append(",\"condition\":").append(quote(node.cond))
                    .append(",\"trueSuccessor\":").append(quote(node.succTrue == null ? null : node.succTrue.toString()))
                    .append(",\"falseSuccessor\":").append(quote(node.succFalse == null ? null : node.succFalse.toString()));
            }
            if (node.note != null && !node.note.isEmpty()) nodes.append(",\"note\":").append(quote(node.note.substring(0, Math.min(256, node.note.length()))));
            nodes.append('}');
            writtenNodes++;
        }
        if (edgeCount >= MAX_EDGES_PER_FUNCTION) truncated = true;
        return "{\"entry\":" + quote(detection.entry.toString())
            + ",\"dispatcher\":" + quote(detection.dispatcher == null ? null : detection.dispatcher.toString())
            + ",\"score\":" + String.format(java.util.Locale.ROOT, "%.4f", detection.score)
            + ",\"state\":" + quote(detection.stateHint)
            + ",\"firstHead\":" + quote(recovery.firstHead == null ? null : recovery.firstHead.toString())
            + ",\"lowConfidence\":" + recovery.lowConfidence
            + ",\"confidenceNote\":" + quote(recovery.confidenceNote == null ? "" : recovery.confidenceNote.substring(0, Math.min(500, recovery.confidenceNote.length())))
            + ",\"resolved\":" + recovery.resolved + ",\"conditional\":" + recovery.conditional
            + ",\"unresolved\":" + recovery.unresolved + ",\"truncated\":" + truncated
            + ",\"nodes\":[" + nodes + "]}";
    }

    @Override
    public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length < 2) throw new IllegalArgumentException("Expected output JSON path and function scan limit");
        Path output = Path.of(arguments[0]);
        int maxFunctions = Math.max(1, Math.min(20_000, Integer.parseInt(arguments[1])));
        CffCore.MAX_STEPS = 20_000;

        StringBuilder functionsJson = new StringBuilder();
        int scanned = 0;
        int recovered = 0;
        int failures = 0;
        boolean truncated = false;
        FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
        while (functions.hasNext()) {
            monitor.checkCancelled();
            if (scanned >= maxFunctions || recovered >= MAX_RECOVERED_FUNCTIONS) {
                truncated = true;
                break;
            }
            Function function = functions.next();
            if (function.isExternal() || function.isThunk()) continue;
            scanned++;
            monitor.setMessage("Checking native control-flow flattening: " + function.getName());
            try {
                CffCore.Detect detection = CffCore.detect(currentProgram, function, monitor);
                if (!detection.isCff) continue;
                CffCore.Recovery recovery = CffCore.recover(currentProgram, detection, monitor);
                if (recovered > 0) functionsJson.append(',');
                functionsJson.append(recoveryJson(detection, recovery));
                recovery.trim();
                recovered++;
            }
            catch (CancelledException error) {
                throw error;
            }
            catch (Exception ignored) {
                failures++;
            }
        }

        String outputJson = "{\"version\":\"reamon-cff-recovery-v1\",\"scanned\":" + scanned
            + ",\"recovered\":" + recovered + ",\"failures\":" + failures
            + ",\"truncated\":" + truncated + ",\"functions\":[" + functionsJson + "]}";
        Files.writeString(output, outputJson, StandardCharsets.UTF_8);
    }
}
