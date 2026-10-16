import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.LambdaExpressionTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.tree.Scope;
import com.sun.source.util.Trees;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.util.Elements;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.ToolProvider;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

public final class ReamonJavaRefactor {
    private static final int MAX_SOURCE_BYTES = 512 * 1024;
    private static final int MAX_BINDINGS = 5000;
    private static final int MAX_RENAMES = 80;
    private static final Pattern IDENTIFIER = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]{0,127}");
    private static final Set<String> KEYWORDS = Set.of(
        "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
        "continue", "default", "do", "double", "else", "enum", "exports", "extends", "final", "finally",
        "float", "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long",
        "module", "native", "new", "open", "opens", "package", "permits", "private", "protected", "provides",
        "public", "record", "requires", "return", "sealed", "short", "static", "strictfp", "super", "switch",
        "synchronized", "this", "throw", "throws", "to", "transient", "transitive", "try", "uses", "var",
        "void", "volatile", "while", "with", "yield", "true", "false", "null"
    );

    private record Rename(String bindingId, String newName) {}
    private record Edit(int start, int end, String oldName, String newName) {}
    private record IdentifierRef(int start, Element symbol) {}
    private static final class Binding {
        final String id;
        final String name;
        final String kind;
        final String scopeType;
        final int declarationStart;
        final List<Integer> references = new ArrayList<>();
        final Element symbol;
        final TreePath declarationPath;

        Binding(String id, String name, String kind, String scopeType, int declarationStart, Element symbol, TreePath declarationPath) {
            this.id = id;
            this.name = name;
            this.kind = kind;
            this.scopeType = scopeType;
            this.declarationStart = declarationStart;
            this.symbol = symbol;
            this.declarationPath = declarationPath;
        }
    }

    private static final class Analysis {
        final String source;
        final String sourceHash;
        final com.sun.source.tree.CompilationUnitTree unit;
        final Trees trees;
        final List<Binding> bindings;
        final Map<Element, Binding> bySymbol;
        final Map<Integer, TreePath> identifiers;
        final List<IdentifierRef> allIdentifiers;
        final List<String> errors;

        Analysis(String source, String sourceHash, com.sun.source.tree.CompilationUnitTree unit, Trees trees,
                 List<Binding> bindings, Map<Element, Binding> bySymbol, Map<Integer, TreePath> identifiers,
                 List<IdentifierRef> allIdentifiers, List<String> errors) {
            this.source = source;
            this.sourceHash = sourceHash;
            this.unit = unit;
            this.trees = trees;
            this.bindings = bindings;
            this.bySymbol = bySymbol;
            this.identifiers = identifiers;
            this.allIdentifiers = allIdentifiers;
            this.errors = errors;
        }
    }

    private static final class SourceFile extends SimpleJavaFileObject {
        private final String source;
        SourceFile(String source) {
            super(URI.create("string:///ReamonInput.java"), JavaFileObject.Kind.SOURCE);
            this.source = source;
        }
        @Override public CharSequence getCharContent(boolean ignoreEncodingErrors) { return source; }
    }

    public static void main(String[] args) {
        try {
            run();
        } catch (Exception exception) {
            emit("E\t" + b64(safeMessage(exception)));
        }
    }

    private static void run() throws Exception {
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String operation = required(input.readLine(), "operation");
        String expectedSha256 = input.readLine();
        if (expectedSha256 == null) expectedSha256 = "";
        String sourceLine = input.readLine();
        if (sourceLine == null) throw new IllegalArgumentException("Java source payload is missing");
        String source = new String(Base64.getDecoder().decode(sourceLine), StandardCharsets.UTF_8);
        List<Rename> renames = new ArrayList<>();
        String line;
        while ((line = input.readLine()) != null) {
            if (line.isBlank()) continue;
            int separator = line.indexOf('\t');
            if (separator <= 0) throw new IllegalArgumentException("Malformed Java rename mapping");
            renames.add(new Rename(line.substring(0, separator), new String(Base64.getDecoder().decode(line.substring(separator + 1)), StandardCharsets.UTF_8)));
        }
        process(operation, expectedSha256, source, renames);
    }

    private static void process(String operation, String expectedSha256, String source, List<Rename> renames) throws Exception {
        byte[] bytes = source.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_SOURCE_BYTES) throw new IllegalArgumentException("Java source exceeds the 512 KiB safe-refactor limit");
        if (!(operation.equals("bindings") || operation.equals("rename") || operation.equals("validate")))
            throw new IllegalArgumentException("A Java bindings, rename, or validate operation is required");
        if (renames.size() > MAX_RENAMES) throw new IllegalArgumentException("The Java rename request exceeds its 80-binding limit");
        String sourceHash = sha256(bytes);
        if (operation.equals("rename") && (!expectedSha256.matches("(?i)[0-9a-f]{64}") || !expectedSha256.equalsIgnoreCase(sourceHash)))
            throw new IllegalArgumentException("The Java source changed after rename suggestions were generated");
        Analysis analysis = analyze(source, sourceHash);
        if (operation.equals("validate")) {
            emit("H\t" + sourceHash + "\t" + version() + "\tfalse");
            String status = analysis.errors.isEmpty() ? "PASSED" : "FAILED";
            String message = analysis.errors.isEmpty()
                ? "javac parsed this Java source without executing it. This is structural evidence; project dependencies and runtime behavior were not checked."
                : "javac rejected the Java syntax: " + String.join("; ", analysis.errors);
            emit("V\t" + status + "\t" + b64(message));
            return;
        }
        if (!analysis.errors.isEmpty()) throw new IllegalArgumentException("javac found Java syntax errors: " + String.join("; ", analysis.errors));
        if (operation.equals("bindings")) {
            boolean truncated = analysis.bindings.size() > MAX_BINDINGS;
            List<Binding> bindings = analysis.bindings.subList(0, Math.min(MAX_BINDINGS, analysis.bindings.size()));
            emit("H\t" + sourceHash + "\t" + version() + "\t" + truncated);
            for (Binding binding : bindings) {
                emit(String.join("\t", "B", binding.id, b64(binding.name), b64(binding.kind), b64(binding.scopeType),
                    Integer.toString(binding.declarationStart), Integer.toString(binding.references.size())));
            }
            return;
        }
        apply(source, sourceHash, analysis, renames);
    }

    private static Analysis analyze(String source, String sourceHash) throws Exception {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) throw new IllegalStateException("A JDK compiler is unavailable");
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        JavacTask task = (JavacTask) compiler.getTask(null, null, diagnostics,
            List.of("--release", "17", "-proc:none", "-Xlint:none"), null, List.of(new SourceFile(source)));
        List<com.sun.source.tree.CompilationUnitTree> units = new ArrayList<>();
        task.parse().forEach(units::add);
        List<String> errors = diagnostics.getDiagnostics().stream()
            .filter(diagnostic -> diagnostic.getKind() == Diagnostic.Kind.ERROR)
            .limit(5).map(diagnostic -> diagnostic.getMessage(null).replace('\n', ' ')).toList();
        if (units.size() != 1) throw new IllegalArgumentException("javac could not parse one Java source unit");
        try { task.analyze(); } catch (RuntimeException ignored) { /* Keep any partial symbol information from isolated source. */ }
        Trees trees = Trees.instance(task);
        var unit = units.get(0);
        var sourcePositions = trees.getSourcePositions();
        Map<Element, Binding> bySymbol = new LinkedHashMap<>();
        Map<Integer, TreePath> identifiers = new HashMap<>();
        List<IdentifierRef> allIdentifiers = new ArrayList<>();
        new TreePathScanner<Void, Void>() {
            @Override public Void visitVariable(VariableTree node, Void unused) {
                TreePath path = getCurrentPath();
                Element symbol = trees.getElement(path);
                if (symbol != null && isSafeBinding(node, path, symbol, unit, sourcePositions)) {
                    int start = declarationNameStart(source, node, unit, sourcePositions);
                    if (start >= 0 && IDENTIFIER.matcher(symbol.getSimpleName().toString()).matches()) {
                        String name = symbol.getSimpleName().toString();
                        String kind = symbol.getKind() == ElementKind.PARAMETER ? "parameter" : "local-variable";
                        String scopeType = kind.equals("parameter") ? "parameter" : "local";
                        bySymbol.put(symbol, new Binding(shortHash(sourceHash + ":" + start + ":" + name), name, kind, scopeType, start, symbol, path));
                    }
                }
                return super.visitVariable(node, unused);
            }

            @Override public Void visitIdentifier(IdentifierTree node, Void unused) {
                TreePath path = getCurrentPath();
                long position = sourcePositions.getStartPosition(unit, node);
                if (position >= 0 && position <= Integer.MAX_VALUE) {
                    int start = (int) position;
                    identifiers.put(start, path);
                    Element symbol = trees.getElement(path);
                    allIdentifiers.add(new IdentifierRef(start, symbol));
                    Binding binding = symbol == null ? null : bySymbol.get(symbol);
                    if (binding != null) binding.references.add(start);
                }
                return super.visitIdentifier(node, unused);
            }
        }.scan(unit, null);
        List<Binding> bindings = bySymbol.values().stream()
            .filter(binding -> !binding.references.isEmpty())
            .sorted(Comparator.comparingInt(binding -> binding.declarationStart)).toList();
        return new Analysis(source, sourceHash, unit, trees, bindings, bySymbol, identifiers, allIdentifiers, errors);
    }

    private static boolean isSafeBinding(VariableTree node, TreePath path, Element symbol,
                                         com.sun.source.tree.CompilationUnitTree unit,
                                         com.sun.source.util.SourcePositions positions) {
        ElementKind kind = symbol.getKind();
        if (!(kind == ElementKind.LOCAL_VARIABLE || kind == ElementKind.PARAMETER || kind == ElementKind.EXCEPTION_PARAMETER
                || kind == ElementKind.RESOURCE_VARIABLE || kind.name().equals("BINDING_VARIABLE"))) return false;
        if (kind != ElementKind.PARAMETER) return true;
        for (TreePath parent = path.getParentPath(); parent != null; parent = parent.getParentPath()) {
            if (parent.getLeaf() instanceof LambdaExpressionTree) return true;
            if (parent.getLeaf() instanceof com.sun.source.tree.MethodTree) return false;
        }
        return false;
    }

    private static int declarationNameStart(String source, VariableTree node,
                                            com.sun.source.tree.CompilationUnitTree unit,
                                            com.sun.source.util.SourcePositions positions) {
        long startLong = positions.getStartPosition(unit, node);
        long endLong = positions.getEndPosition(unit, node);
        if (startLong < 0 || endLong < 0 || endLong > source.length()) return -1;
        int start = (int) startLong;
        int end = (int) endLong;
        Tree type = node.getType();
        long typeEnd = type == null ? startLong : positions.getEndPosition(unit, type);
        int searchStart = typeEnd >= startLong && typeEnd <= endLong ? (int) typeEnd : start;
        String name = node.getName().toString();
        for (int at = source.indexOf(name, searchStart); at >= 0 && at + name.length() <= end; at = source.indexOf(name, at + 1)) {
            int before = at == 0 ? -1 : source.codePointBefore(at);
            int after = at + name.length() >= source.length() ? -1 : source.codePointAt(at + name.length());
            if ((before < 0 || !Character.isJavaIdentifierPart(before)) && (after < 0 || !Character.isJavaIdentifierPart(after))) return at;
        }
        return -1;
    }

    private static void apply(String source, String sourceHash, Analysis analysis, List<Rename> renames) throws Exception {
        if (renames.isEmpty()) throw new IllegalArgumentException("Select at least one Java binding to rename");
        Map<String, Binding> available = new HashMap<>();
        for (Binding binding : analysis.bindings) available.put(binding.id, binding);
        Set<String> selectedIds = new HashSet<>();
        Set<String> proposedNames = new HashSet<>();
        Map<String, String> namesById = new HashMap<>();
        List<Edit> edits = new ArrayList<>();
        for (Rename rename : renames) {
            Binding binding = available.get(rename.bindingId());
            if (binding == null || !selectedIds.add(rename.bindingId())) throw new IllegalArgumentException("A selected Java rename no longer matches a current local binding");
            if (!validName(rename.newName()) || rename.newName().equals(binding.name) || !proposedNames.add(rename.newName()))
                throw new IllegalArgumentException("A selected Java name is invalid or duplicated");
            namesById.put(binding.id, rename.newName());
            if (visibleAt(analysis, binding, rename.newName()))
                throw new IllegalArgumentException("The selected Java name would shadow or capture a visible local symbol");
            edits.add(new Edit(binding.declarationStart, binding.declarationStart + binding.name.length(), binding.name, rename.newName()));
            for (int reference : binding.references) edits.add(new Edit(reference, reference + binding.name.length(), binding.name, rename.newName()));
        }
        edits.sort(Comparator.comparingInt(Edit::start));
        for (int index = 1; index < edits.size(); index++)
            if (edits.get(index).start() < edits.get(index - 1).end()) throw new IllegalArgumentException("javac returned overlapping Java binding edits");
        StringBuilder output = new StringBuilder(source);
        for (int index = edits.size() - 1; index >= 0; index--) {
            Edit edit = edits.get(index);
            if (edit.end() > output.length() || !output.substring(edit.start(), edit.end()).equals(edit.oldName()))
                throw new IllegalArgumentException("A Java binding edit no longer matches the original source");
            output.replace(edit.start(), edit.end(), edit.newName());
        }
        String outputSource = output.toString();
        String outputHash = sha256(outputSource.getBytes(StandardCharsets.UTF_8));
        Analysis outputAnalysis = analyze(outputSource, outputHash);
        if (!outputAnalysis.errors.isEmpty()) throw new IllegalArgumentException("javac found syntax errors in the renamed Java source");
        Map<Integer, Binding> outputByDeclaration = new HashMap<>();
        for (Binding binding : outputAnalysis.bindings) outputByDeclaration.put(binding.declarationStart, binding);
        int[] outputBindingStarts = new int[analysis.bindings.size()];
        Map<String, Binding> outputByOriginalId = new HashMap<>();
        for (int index = 0; index < analysis.bindings.size(); index++) {
            Binding original = analysis.bindings.get(index);
            int newStart = translate(original.declarationStart, edits);
            Binding changed = outputByDeclaration.get(newStart);
            String wantedName = namesById.getOrDefault(original.id, original.name);
            if (changed == null || !changed.name.equals(wantedName)) throw new IllegalArgumentException("javac could not resolve a Java binding after the rename");
            outputBindingStarts[index] = newStart;
            outputByOriginalId.put(original.id, changed);
            for (int reference : original.references) {
                TreePath outputPath = outputAnalysis.identifiers.get(translate(reference, edits));
                if (outputPath == null || !changed.symbol.equals(outputAnalysis.trees.getElement(outputPath)))
                    throw new IllegalArgumentException("The Java rename would redirect a local reference to a different binding");
            }
        }
        Set<Element> renamedSymbols = new HashSet<>();
        for (String id : selectedIds) renamedSymbols.add(outputByOriginalId.get(id).symbol);
        Set<Element> originalCatalogSymbols = new HashSet<>(analysis.bySymbol.keySet());
        for (IdentifierRef identifier : analysis.allIdentifiers) {
            if (identifier.symbol() != null && originalCatalogSymbols.contains(identifier.symbol())) continue;
            TreePath outputPath = outputAnalysis.identifiers.get(translate(identifier.start(), edits));
            if (outputPath != null && renamedSymbols.contains(outputAnalysis.trees.getElement(outputPath)))
                throw new IllegalArgumentException("The Java rename would capture an existing or unresolved identifier");
        }
        emit("H\t" + sourceHash + "\t" + version() + "\tfalse");
        emit("O\t" + outputHash + "\t" + Base64.getEncoder().encodeToString(outputSource.getBytes(StandardCharsets.UTF_8)));
        for (Rename rename : renames) {
            Binding binding = available.get(rename.bindingId());
            emit(String.join("\t", "R", binding.id, b64(binding.name), b64(rename.newName()), b64(binding.kind), Integer.toString(binding.references.size())));
        }
    }

    private static boolean visibleAt(Analysis analysis, Binding selected, String newName) {
        try {
            for (Scope scope = analysis.trees.getScope(selected.declarationPath); scope != null; scope = scope.getEnclosingScope()) {
                for (Element element : scope.getLocalElements()) {
                    if (!element.equals(selected.symbol) && element.getSimpleName().contentEquals(newName)) return true;
                }
            }
        } catch (IllegalArgumentException ignored) {
            return true;
        }
        return false;
    }

    private static int translate(int offset, List<Edit> edits) {
        int translated = offset;
        for (Edit edit : edits) if (edit.end() <= offset) translated += edit.newName().length() - edit.oldName().length();
        return translated;
    }

    private static boolean validName(String name) { return IDENTIFIER.matcher(name).matches() && !KEYWORDS.contains(name); }
    private static String required(String value, String name) { if (value == null) throw new IllegalArgumentException("Java refactor " + name + " is missing"); return value; }
    private static String safeMessage(Exception exception) { String message = exception.getMessage(); return message == null ? "javac could not safely analyze this Java source" : message.replace('\n', ' ').substring(0, Math.min(300, message.length())); }
    private static String version() { Runtime.Version v = Runtime.version(); return v.feature() + "." + v.interim() + "." + v.update(); }
    private static String b64(String value) { return Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8)); }
    private static void emit(String line) { System.out.println(line); }
    private static String sha256(byte[] data) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder value = new StringBuilder();
        for (byte b : digest) value.append(String.format("%02x", b & 0xff));
        return value.toString();
    }
    private static String shortHash(String value) {
        try { return sha256(value.getBytes(StandardCharsets.UTF_8)).substring(0, 24); }
        catch (Exception exception) { throw new IllegalStateException("SHA-256 is unavailable", exception); }
    }
}
