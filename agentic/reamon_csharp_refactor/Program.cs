using System.Security.Cryptography;
using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

internal static class Program
{
    private const int MaxSourceBytes = 512 * 1024;
    private const int MaxBindings = 5000;
    private const int MaxRenames = 80;
    private static readonly Regex Identifier = new(@"^[A-Za-z_][A-Za-z0-9_]{0,127}$", RegexOptions.CultureInvariant);
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private sealed record Request(string Operation, string SourceCode, string ExpectedSha256, Rename[] Renames);
    private sealed record Rename(string BindingId, string NewName);
    private sealed record Binding(
        string Id,
        string Name,
        string Kind,
        string ScopeType,
        int DeclarationStart,
        int ReferenceCount,
        bool Exported,
        ISymbol Symbol,
        TextSpan DeclarationSpan,
        ImmutableArray<TextSpan> References);

    public static int Main()
    {
        try
        {
            var requestJson = Console.In.ReadToEnd();
            using var document = JsonDocument.Parse(requestJson);
            var root = document.RootElement;
            var request = new Request(
                GetString(root, "operation"),
                GetString(root, "source_code"),
                GetString(root, "expected_sha256"),
                ReadRenames(root));
            var result = Run(request);
            Console.Out.WriteLine(JsonSerializer.Serialize(result, JsonOptions));
            return 0;
        }
        catch (RefactorException exception)
        {
            Console.Out.WriteLine(JsonSerializer.Serialize(new { error = exception.Message }));
            return 0;
        }
        catch (Exception)
        {
            Console.Out.WriteLine(JsonSerializer.Serialize(new { error = "Roslyn could not safely analyze this C# source" }));
            return 0;
        }
    }

    private static string GetString(JsonElement root, string name)
    {
        return root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;
    }

    private static Rename[] ReadRenames(JsonElement root)
    {
        if (!root.TryGetProperty("renames", out var value) || value.ValueKind != JsonValueKind.Array)
            return [];
        return value.EnumerateArray().Select(item => new Rename(
            GetString(item, "binding_id"), GetString(item, "new_name"))).ToArray();
    }

    private static object Run(Request request)
    {
        var sourceBytes = Encoding.UTF8.GetBytes(request.SourceCode);
        if (sourceBytes.Length > MaxSourceBytes)
            throw new RefactorException("C# source exceeds the 512 KiB safe-rename limit");
        var sourceHash = Hash(sourceBytes);
        if (request.Operation == "rename" &&
            (!Regex.IsMatch(request.ExpectedSha256, "^[a-fA-F0-9]{64}$", RegexOptions.CultureInvariant) ||
             !string.Equals(request.ExpectedSha256, sourceHash, StringComparison.OrdinalIgnoreCase)))
            throw new RefactorException("The C# source changed after rename suggestions were generated");
        if (request.Operation is not ("bindings" or "rename" or "validate"))
            throw new RefactorException("A C# bindings, rename, or validate operation is required");
        if (request.Renames.Length > MaxRenames)
            throw new RefactorException("The C# rename request exceeds its 80-binding limit");

        if (request.Operation == "validate")
        {
            var tree = CSharpSyntaxTree.ParseText(request.SourceCode,
                new CSharpParseOptions(languageVersion: LanguageVersion.Latest), path: "unit.cs");
            var errors = tree.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error).Take(5).ToArray();
            var version = RoslynVersion();
            var detail = string.Join("; ", errors.Select(error => error.GetMessage()).Select(message => message.Replace('\n', ' '))).Trim();
            return new
            {
                source_sha256 = sourceHash,
                validation_status = errors.Length == 0 ? "PASSED" : "FAILED",
                validation_method = $"roslyn-csharp-{version}-parse",
                validation_message = errors.Length == 0
                    ? $"Roslyn {version} parsed this C# source without executing it. This is structural evidence; project references, compilation, and runtime behavior were not checked."
                    : $"Roslyn {version} rejected the C# source: {detail}",
            };
        }

        var analysis = Analyze(request.SourceCode, sourceHash);
        if (request.Operation == "bindings")
            return new
            {
                source_sha256 = sourceHash,
                parser_version = RoslynVersion(),
                bindings = analysis.Bindings.Select(ToPublicBinding).ToArray(),
                truncated = analysis.Truncated,
            };
        return ApplyRenames(request, analysis, sourceHash);
    }

    private sealed record Analysis(SyntaxTree Tree, CompilationUnitSyntax Root, SemanticModel Model, List<Binding> Bindings, bool Truncated);

    private static Analysis Analyze(string source, string sourceHash)
    {
        var parseOptions = new CSharpParseOptions(languageVersion: LanguageVersion.Latest, documentationMode: DocumentationMode.Parse);
        var tree = CSharpSyntaxTree.ParseText(SourceText.From(source, Encoding.UTF8), parseOptions, path: "unit.cs");
        var root = tree.GetCompilationUnitRoot();
        if (tree.GetDiagnostics().Any(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error))
            throw new RefactorException("Roslyn found C# syntax errors; safe renaming requires parseable source");

        var references = PlatformReferences();
        var compilation = CSharpCompilation.Create(
            "REAmonRename",
            [tree],
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true, nullableContextOptions: NullableContextOptions.Enable));
        var model = compilation.GetSemanticModel(tree, ignoreAccessibility: true);
        var declarations = new Dictionary<ISymbol, (SyntaxToken Identifier, string Kind, string ScopeType)>(SymbolEqualityComparer.Default);

        foreach (var node in root.DescendantNodesAndSelf())
        {
            ISymbol? symbol = null;
            SyntaxToken identifier = default;
            string kind = "";
            string scopeType = "local";
            switch (node)
            {
                case VariableDeclaratorSyntax declarator:
                    symbol = model.GetDeclaredSymbol(declarator);
                    identifier = declarator.Identifier;
                    kind = "local-variable";
                    break;
                case ParameterSyntax parameter:
                    symbol = model.GetDeclaredSymbol(parameter);
                    identifier = parameter.Identifier;
                    kind = "parameter";
                    scopeType = "parameter";
                    if (symbol is IParameterSymbol parameterSymbol && !IsSafeParameter(parameterSymbol))
                        symbol = null;
                    break;
                case SingleVariableDesignationSyntax designation:
                    symbol = model.GetDeclaredSymbol(designation);
                    identifier = designation.Identifier;
                    kind = "local-variable";
                    break;
                case CatchDeclarationSyntax catchDeclaration:
                    symbol = model.GetDeclaredSymbol(catchDeclaration);
                    identifier = catchDeclaration.Identifier;
                    kind = "local-variable";
                    break;
                case LocalFunctionStatementSyntax localFunction:
                    symbol = model.GetDeclaredSymbol(localFunction);
                    identifier = localFunction.Identifier;
                    kind = "local-function";
                    break;
                case FromClauseSyntax fromClause:
                    symbol = model.GetDeclaredSymbol(fromClause);
                    identifier = fromClause.Identifier;
                    kind = "range-variable";
                    break;
                case LetClauseSyntax letClause:
                    symbol = model.GetDeclaredSymbol(letClause);
                    identifier = letClause.Identifier;
                    kind = "range-variable";
                    break;
                case JoinClauseSyntax joinClause:
                    symbol = model.GetDeclaredSymbol(joinClause);
                    identifier = joinClause.Identifier;
                    kind = "range-variable";
                    break;
                case JoinIntoClauseSyntax joinIntoClause:
                    symbol = model.GetDeclaredSymbol(joinIntoClause);
                    identifier = joinIntoClause.Identifier;
                    kind = "range-variable";
                    break;
                case QueryContinuationSyntax queryContinuation:
                    symbol = model.GetDeclaredSymbol(queryContinuation);
                    identifier = queryContinuation.Identifier;
                    kind = "range-variable";
                    break;
            }

            if (symbol is null || identifier.IsMissing || !Identifier.IsMatch(identifier.ValueText) || identifier.Text != identifier.ValueText)
                continue;
            if (symbol is ILocalSymbol && symbol.Kind == SymbolKind.Local)
            {
                if (kind != "local-function") kind = "local-variable";
            }
            else if (symbol is IParameterSymbol)
            {
                kind = "parameter";
                scopeType = "parameter";
            }
            else if (symbol is IRangeVariableSymbol)
            {
                kind = "range-variable";
            }
            else if (symbol is IMethodSymbol { MethodKind: MethodKind.LocalFunction })
            {
                kind = "local-function";
            }
            else
            {
                continue;
            }
            declarations[symbol] = (identifier, kind, scopeType);
        }

        var referenceTokens = declarations.Keys.ToDictionary(symbol => symbol, _ => new List<TextSpan>(), SymbolEqualityComparer.Default);
        foreach (var identifierName in root.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>())
        {
            var symbol = model.GetSymbolInfo(identifierName).Symbol;
            if (symbol is null || !referenceTokens.TryGetValue(symbol, out var spans))
                continue;
            if (identifierName.Identifier.Text != symbol.Name)
                spans.Clear();
            else
                spans.Add(identifierName.Identifier.Span);
        }
        foreach (var namedArgument in root.DescendantNodesAndSelf().OfType<NameColonSyntax>())
        {
            var symbol = model.GetSymbolInfo(namedArgument.Name).Symbol;
            if (symbol is IParameterSymbol && referenceTokens.TryGetValue(symbol, out var spans))
                spans.Add(namedArgument.Name.Identifier.Span);
        }

        var bindings = new List<Binding>();
        foreach (var (symbol, declaration) in declarations)
        {
            var referencesForBinding = referenceTokens[symbol];
            if (referencesForBinding.Count == 0 || referencesForBinding.Count > 20_000)
                continue;
            var start = declaration.Identifier.SpanStart;
            var id = Hash(Encoding.UTF8.GetBytes($"{sourceHash}:{start}:{symbol.Name}"))[..24];
            bindings.Add(new Binding(
                id,
                symbol.Name,
                declaration.Kind,
                declaration.ScopeType,
                start,
                referencesForBinding.Count,
                false,
                symbol,
                declaration.Identifier.Span,
                referencesForBinding.Distinct().ToImmutableArray()));
        }
        bindings.Sort((left, right) => left.DeclarationStart.CompareTo(right.DeclarationStart));
        var truncated = bindings.Count > MaxBindings;
        if (truncated) bindings = bindings.Take(MaxBindings).ToList();
        return new Analysis(tree, root, model, bindings, truncated);
    }

    private static bool IsSafeParameter(IParameterSymbol parameter)
    {
        if (parameter.ContainingSymbol is not IMethodSymbol method)
            return false;
        if (method.MethodKind is MethodKind.AnonymousFunction or MethodKind.LocalFunction)
            return true;
        if (method.DeclaredAccessibility != Accessibility.Private)
            return false;
        var containingType = method.ContainingType;
        return containingType is null || !containingType.DeclaringSyntaxReferences
            .Select(reference => reference.GetSyntax())
            .OfType<TypeDeclarationSyntax>()
            .Any(type => type.Modifiers.Any(SyntaxKind.PartialKeyword));
    }

    private static ImmutableArray<MetadataReference> PlatformReferences()
    {
        var paths = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrWhiteSpace(paths))
            return [MetadataReference.CreateFromFile(typeof(object).Assembly.Location)];
        return paths.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Distinct(StringComparer.Ordinal)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToImmutableArray();
    }

    private static object ToPublicBinding(Binding binding)
    {
        return new
        {
            binding.Id,
            binding.Name,
            binding.Kind,
            binding.ScopeType,
            binding.DeclarationStart,
            binding.ReferenceCount,
            binding.Exported,
        };
    }

    private static object ApplyRenames(Request request, Analysis analysis, string sourceHash)
    {
        if (request.Renames.Length is < 1 or > MaxRenames)
            throw new RefactorException("Select between 1 and 80 C# bindings to rename");
        var available = analysis.Bindings.ToDictionary(binding => binding.Id, StringComparer.Ordinal);
        var selected = new List<(Binding Binding, string NewName)>();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var proposedNames = new HashSet<string>(StringComparer.Ordinal);
        foreach (var selection in request.Renames)
        {
            if (!available.TryGetValue(selection.BindingId, out var binding) || !ids.Add(selection.BindingId))
                throw new RefactorException("A selected C# rename no longer matches a current local binding");
            if (!IsValidName(selection.NewName) || selection.NewName == binding.Name || !proposedNames.Add(selection.NewName))
                throw new RefactorException("A selected C# name is invalid or duplicated");
            var visible = analysis.Model.LookupSymbols(binding.DeclarationStart, name: selection.NewName);
            if (visible.Any(symbol => !SymbolEqualityComparer.Default.Equals(symbol, binding.Symbol)))
                throw new RefactorException("The selected C# name would shadow or capture a visible symbol");
            selected.Add((binding, selection.NewName));
        }

        var edits = new List<(TextSpan Span, string OldName, string NewName)>();
        var renamedBindings = new List<object>();
        foreach (var (binding, newName) in selected)
        {
            edits.Add((binding.DeclarationSpan, binding.Name, newName));
            edits.AddRange(binding.References.Select(span => (span, binding.Name, newName)));
            renamedBindings.Add(new
            {
                bindingId = binding.Id,
                oldName = binding.Name,
                newName,
                kind = binding.Kind,
                referenceCount = binding.ReferenceCount,
            });
        }
        var sorted = edits.OrderBy(edit => edit.Span.Start).ToArray();
        for (var index = 1; index < sorted.Length; index++)
        {
            if (sorted[index].Span.Start < sorted[index - 1].Span.End)
                throw new RefactorException("Roslyn returned overlapping C# binding edits");
        }
        var output = request.SourceCode;
        foreach (var edit in sorted.Reverse())
        {
            if (edit.Span.End > output.Length || output.Substring(edit.Span.Start, edit.Span.Length) != edit.OldName)
                throw new RefactorException("A C# binding edit no longer matches the original source");
            output = output[..edit.Span.Start] + edit.NewName + output[edit.Span.End..];
        }
        var outputTree = CSharpSyntaxTree.ParseText(SourceText.From(output, Encoding.UTF8), (CSharpParseOptions)analysis.Tree.Options, path: "unit.cs");
        if (outputTree.GetDiagnostics().Any(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error))
            throw new RefactorException("Roslyn found syntax errors in the renamed C# source");
        var outputHash = Hash(Encoding.UTF8.GetBytes(output));
        return new
        {
            source_sha256 = sourceHash,
            output_sha256 = outputHash,
            source_code = output,
            parser_version = RoslynVersion(),
            renamed_bindings = renamedBindings,
        };
    }

    private static bool IsValidName(string name)
    {
        return Identifier.IsMatch(name)
            && SyntaxFacts.GetKeywordKind(name) == SyntaxKind.None
            && SyntaxFacts.GetContextualKeywordKind(name) == SyntaxKind.None;
    }

    private static string RoslynVersion()
    {
        var version = typeof(CSharpCompilation).Assembly.GetName().Version;
        return version is null ? "0.0.0" : $"{version.Major}.{version.Minor}.{version.Build}";
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private sealed class RefactorException(string message) : Exception(message);
}
